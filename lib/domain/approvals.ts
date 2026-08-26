import { prisma, type Db } from "../db";
import { writeAudit } from "./auditLog";
import { canSchedule, type GateResult } from "./gate";
import { CHURN_DECLINE_THRESHOLD, flagApprovalChurn } from "./misuse";
import {
  applyTransition,
  type ApprovalStage,
  type ContentStatus,
} from "./statusMachine";

/**
 * Recording a review decision on one content item.
 *
 * Approve, decline, and late-revoke are **one function** here, because they are
 * one action at the domain layer: each writes an `Approval` row and re-runs the
 * status machine. "Late-revoke" is not a distinct operation -- it is a decline
 * that happens to arrive when the item is already `internal_approved`,
 * `client_approved`, or `scheduled`. The architecture calls this out as one code
 * path with no per-cause branching (§5), and a second function here is exactly
 * how the two copies drift until one of them forgets to unschedule.
 *
 * What this deliberately does not decide:
 *
 *   - **Whether the caller may act.** `permissions.enforce` answers that, and
 *     the route asks it before calling in.
 *   - **What the transition is.** `statusMachine.applyTransition` is the pure
 *     table; this only persists what it returns.
 *   - **Whether the item may now be scheduled.** `gate.canSchedule` re-reads the
 *     rows for itself. The gate result returned here is a report of what the
 *     gate says *after* this write, never a substitute for the scheduler's own
 *     atomic re-check at publish time.
 */

export const APPROVAL_STAGES = ["internal", "client"] as const;
export const APPROVAL_DECISIONS = ["approve", "decline"] as const;

export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export class ApprovalValidationError extends Error {
  readonly code = "APPROVAL_VALIDATION";
  /** Field-keyed so a review screen can show each message against its input. */
  readonly issues: Record<string, string>;

  constructor(issues: Record<string, string>) {
    super(`Invalid approval: ${Object.keys(issues).join(", ")}.`);
    this.name = "ApprovalValidationError";
    this.issues = issues;
  }
}

/**
 * A decision the status machine refuses -- declining an item that is already
 * `published`, or approving out of order.
 *
 * Separate from `ApprovalValidationError` because the body was well-formed: it
 * is the item's current state that makes the decision impossible, and the caller
 * needs the status to understand why.
 */
export class ApprovalNotAllowedError extends Error {
  readonly code = "APPROVAL_NOT_ALLOWED";
  readonly status: ContentStatus;

  constructor(message: string, status: ContentStatus) {
    super(message);
    this.name = "ApprovalNotAllowedError";
    this.status = status;
  }
}

export class ContentItemNotFoundError extends Error {
  readonly code = "CONTENT_ITEM_NOT_FOUND";
  constructor(contentItemId: string) {
    super(`No content item "${contentItemId}".`);
    this.name = "ContentItemNotFoundError";
  }
}

export type RecordDecisionInput = {
  stage: ApprovalStage;
  decision: ApprovalDecision;
  /** Required on a decline (PRD §6): a human reads it either way. */
  comment?: string | null;
  decidedById: string;
  /** Set by the bulk "approve whole plan" shortcut to group its rows. */
  bulkActionId?: string | null;
};

export type RecordDecisionResult = {
  approvalId: string;
  contentItemId: string;
  stage: ApprovalStage;
  decision: ApprovalDecision;
  /** The status before this decision, so a caller can show what moved. */
  previousStatus: ContentStatus;
  status: ContentStatus;
  /** True when this decision released a scheduled slot -- a late revoke. */
  unscheduled: boolean;
  /** Whether *this* decision arrived after the item was already approved. */
  lateRevoke: boolean;
  /** What the gate says now. Reported, never a licence to publish. */
  gate: GateResult;
};

/**
 * Write one decision and apply its consequence.
 *
 * The write runs in a transaction: the `Approval` row and the resulting
 * `ContentItem.status` are one fact, and a crash between them would leave an
 * item that was declined but still reads as `scheduled`. The gate would still
 * refuse to publish it -- the gate reads approvals, not status -- but the item
 * would sit in the scheduler's polling window forever, failing its re-check on
 * every tick, and would show a reviewer a status that contradicts its own
 * approval history. Committing both together keeps the two readings agreeing.
 */
export async function recordDecision(
  contentItemId: string,
  input: RecordDecisionInput,
  db: Db = prisma,
): Promise<RecordDecisionResult> {
  const { stage, decision, comment, decidedById, bulkActionId } = validate(input);

  const written = await db.$transaction(async (tx) => {
    const item = await tx.contentItem.findUnique({
      where: { content_item_id: contentItemId },
      select: { content_item_id: true, campaign_id: true, status: true },
    });

    if (!item) throw new ContentItemNotFoundError(contentItemId);

    const previousStatus = item.status as ContentStatus;

    // The pure table decides. A decline at `published` is refused here, which is
    // the ERD's "decline stops applying once publishing or published" -- the only
    // remaining lever on a live post is the staff-only take-down action.
    const transition = applyTransition(previousStatus, {
      cause: decision === "approve" ? "approve" : "decline",
      stage,
    });

    if (!transition.ok) {
      throw new ApprovalNotAllowedError(
        transition.reason ?? `Cannot ${decision} an item that is ${previousStatus}.`,
        previousStatus,
      );
    }

    const approval = await tx.approval.create({
      data: {
        content_item_id: contentItemId,
        stage,
        decision,
        comment,
        decided_by_id: decidedById,
        bulk_action_id: bulkActionId,
      },
    });

    // An internal approval hands the item to the client in the same step.
    //
    // Without this an internally-approved item is stranded: the status machine
    // makes `internal_approved -> client_approved` illegal on purpose -- the two
    // stages are ordered, and a client cannot approve something that has not
    // been put in front of them -- so the client's stage would never become
    // reachable and the second half of the two-stage review could never run.
    //
    // It is one movement rather than a separate "send to client" action because
    // there is no decision in between. The reviewer's approval *is* the handoff;
    // an extra button would be a second thing to forget, and an item sitting at
    // `internal_approved` that nobody had pushed onward is indistinguishable, on
    // any screen, from one the client is simply slow to answer.
    const status =
      transition.status === "internal_approved" ? "pending_client_review" : transition.status;

    // An item pulled back from `scheduled` loses the slot as well as the status.
    // Leaving `scheduled_date` set would keep it in the scheduler's polling
    // window, where only the gate would stop it -- correct, but relying on the
    // last line of defence for something this layer can simply undo.
    await tx.contentItem.update({
      where: { content_item_id: contentItemId },
      data: {
        status,
        ...(transition.unschedule ? { scheduled_date: null } : {}),
      },
    });

    await writeAudit(
      {
        entityType: "ContentItem",
        entityId: contentItemId,
        action: decision === "approve" ? "approved" : "declined",
        performedById: decidedById,
        details: {
          approval_id: approval.approval_id,
          stage,
          decision,
          from_status: previousStatus,
          to_status: status,
          // The word the Admin's trail needs: this is what separates a routine
          // decline in review from an approval pulled back after the fact.
          late_revoke: isLateRevoke(previousStatus, decision),
          unscheduled: transition.unschedule,
          ...(bulkActionId ? { bulk_action_id: bulkActionId } : {}),
        },
      },
      tx,
    );

    return {
      approvalId: approval.approval_id,
      previousStatus,
      status,
      unscheduled: transition.unschedule,
      campaignId: item.campaign_id,
    };
  });

  // Outside the transaction on purpose. Churn is a signal about a pattern across
  // many decisions, not part of this one's atomic fact -- and a failure to raise
  // it must never roll back a recorded decline.
  if (decision === "decline") {
    await noteChurn(contentItemId, written.campaignId, db);
  }

  return {
    approvalId: written.approvalId,
    contentItemId,
    stage,
    decision,
    previousStatus: written.previousStatus,
    status: written.status,
    unscheduled: written.unscheduled,
    lateRevoke: isLateRevoke(written.previousStatus, decision),
    gate: await canSchedule(contentItemId, db),
  };
}

/**
 * Whether this decline pulled back an approval that was already given.
 *
 * Reported for the audit trail and for the UI's "this post is already scheduled"
 * confirmation state. The domain consequence is identical either way -- that is
 * the point of the symmetric late-revoke decision, and nothing downstream
 * branches on this.
 */
function isLateRevoke(previousStatus: ContentStatus, decision: ApprovalDecision): boolean {
  if (decision !== "decline") return false;
  return (
    previousStatus === "internal_approved" ||
    previousStatus === "client_approved" ||
    previousStatus === "scheduled"
  );
}

/** Counts declines on this item and raises churn once past the threshold. */
async function noteChurn(contentItemId: string, campaignId: string, db: Db): Promise<void> {
  const declineCount = await db.approval.count({
    where: { content_item_id: contentItemId, decision: "decline" },
  });

  if (declineCount < CHURN_DECLINE_THRESHOLD) return;

  // `raisedAgainstId` is left null deliberately: churn is a property of the
  // item's history, not of whoever happened to file the decline that crossed the
  // threshold. Naming them would read as an accusation of a reviewer doing their
  // job on an item several other people have also sent back.
  await flagApprovalChurn({ contentItemId, declineCount, campaignId }, db);
}

type ValidDecision = {
  stage: ApprovalStage;
  decision: ApprovalDecision;
  decidedById: string;
  comment: string | null;
  bulkActionId: string | null;
};

/** Field-level checks, before anything is read or written. */
function validate(input: RecordDecisionInput): ValidDecision {
  const issues: Record<string, string> = {};

  if (!(APPROVAL_STAGES as readonly string[]).includes(input.stage)) {
    issues.stage = `Stage must be one of: ${APPROVAL_STAGES.join(", ")}.`;
  }

  if (!(APPROVAL_DECISIONS as readonly string[]).includes(input.decision)) {
    issues.decision = `Decision must be one of: ${APPROVAL_DECISIONS.join(", ")}.`;
  }

  const comment = typeof input.comment === "string" ? input.comment.trim() : "";

  // Required on a decline, per PRD §6: free text rather than reason codes,
  // because a human reads it either way -- and an item bounced back to `drafted`
  // with no explanation is an item whose author cannot act on the rejection.
  if (input.decision === "decline" && comment === "") {
    issues.comment = "A decline needs a comment saying what to fix.";
  }

  if (!input.decidedById) {
    issues.decidedById = "A decision must name who made it.";
  }

  if (Object.keys(issues).length > 0) throw new ApprovalValidationError(issues);

  return {
    stage: input.stage,
    decision: input.decision,
    decidedById: input.decidedById,
    comment: comment === "" ? null : comment,
    bulkActionId: input.bulkActionId ?? null,
  };
}
