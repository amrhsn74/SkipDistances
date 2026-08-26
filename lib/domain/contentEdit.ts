import { prisma, type Db } from "../db";
// Reused rather than redeclared: `respond.ts` maps this one class to a 404, and
// a second class with the same name would answer 500 from exactly one route.
import { ContentItemNotFoundError } from "./approvals";
import { writeAudit } from "./auditLog";
import { canSchedule, type GateResult } from "./gate";
import { applyTransition, type ContentStatus } from "./statusMachine";

/**
 * A creator editing a draft by hand.
 *
 * The plain-typing counterpart to `regenerateItem`, and deliberately routed
 * through the **same** invalidation. From the PRD: "any change to an
 * already-approved post -- an edit, a schedule-date change, or a withdrawn
 * approval -- resets it to draft and requires both stages to clear again. One
 * rule, applied the same way regardless of cause."
 *
 * So this calls `applyTransition` with `content_edit`, exactly as regeneration
 * does, and persists whatever the pure table returns. There is no branch here
 * for "but it was only a small edit", because the moment such a branch exists it
 * is the one an approved post slips through.
 *
 * What this does not do:
 *
 *   - **Decide whether the caller may edit.** `permissions.enforce` answers
 *     that, and the route asks before calling in.
 *   - **Re-check compliance.** A hand edit is a human writing text, and the
 *     grounding it was drafted under still stands; what protects the client is
 *     that the edit resets the approvals and the item goes back through review.
 *     Running the model over a typed sentence would spend a call to produce an
 *     opinion nobody asked for and that the reviewer is about to form anyway.
 *   - **Submit for review.** Editing and submitting are separate acts, and a
 *     save that also submitted would take the decision out of the creator's
 *     hands mid-sentence.
 */

export class ContentEditValidationError extends Error {
  readonly code = "CONTENT_EDIT_VALIDATION";
  /** Field-keyed so the editor can show the message against its input. */
  readonly issues: Record<string, string>;

  constructor(issues: Record<string, string>) {
    super(`Invalid edit: ${Object.keys(issues).join(", ")}.`);
    this.name = "ContentEditValidationError";
    this.issues = issues;
  }
}

/**
 * The item exists, but its current status refuses an edit -- it is publishing,
 * or already published.
 *
 * Separate from the validation error because the body was well-formed: it is the
 * item's state that refuses, and the caller needs the status to say so.
 */
export class ContentEditNotAllowedError extends Error {
  readonly code = "CONTENT_EDIT_NOT_ALLOWED";
  readonly status: ContentStatus;

  constructor(message: string, status: ContentStatus) {
    super(message);
    this.name = "ContentEditNotAllowedError";
    this.status = status;
  }
}

export type EditDraftInput = {
  contentBody: string;
  editedById: string;
};

export type EditDraftResult = {
  contentItemId: string;
  previousStatus: ContentStatus;
  status: ContentStatus;
  /** True when the edit released a scheduled slot. */
  unscheduled: boolean;
  /** True when the edit invalidated approvals that had already been given. */
  resetApprovals: boolean;
  /** What the gate says now. Reported, never a licence to publish. */
  gate: GateResult;
};

/**
 * Save new body text on a draft.
 *
 * One transaction: the new text and the resulting status are one fact. A crash
 * between them would leave edited copy sitting at `client_approved` -- content
 * nobody approved, wearing an approval.
 */
export async function editDraft(
  contentItemId: string,
  input: EditDraftInput,
  db: Db = prisma,
): Promise<EditDraftResult> {
  const issues: Record<string, string> = {};

  const contentBody = (input.contentBody ?? "").trim();
  if (contentBody === "") {
    // An empty body is not an edit, it is a deletion by another name -- and a
    // deleted caption on an approved post would reset the approvals to produce
    // nothing. Removing an item is a different action this product does not have.
    issues.contentBody = "A draft needs some text. To remove it, delete the item instead.";
  }

  if (!input.editedById) issues.editedById = "An edit must name who made it.";

  if (Object.keys(issues).length > 0) throw new ContentEditValidationError(issues);

  const written = await db.$transaction(async (tx) => {
    const existing = await tx.contentItem.findUnique({
      where: { content_item_id: contentItemId },
      select: { content_item_id: true, status: true, content_body: true },
    });

    if (!existing) throw new ContentItemNotFoundError(contentItemId);

    const previousStatus = existing.status as ContentStatus;

    // The pure table decides. It refuses at `publishing` and `published`, which
    // is the same boundary a decline stops at -- a live post is changed by a
    // take-down, not by editing the row underneath it.
    const transition = applyTransition(previousStatus, { cause: "content_edit" });

    if (!transition.ok) {
      throw new ContentEditNotAllowedError(
        transition.reason ?? `Cannot edit an item that is ${previousStatus}.`,
        previousStatus,
      );
    }

    await tx.contentItem.update({
      where: { content_item_id: contentItemId },
      data: {
        content_body: contentBody,
        status: transition.status,
        // An item pulled back from `scheduled` loses the slot as well as the
        // status, for the same reason a late revoke does: leaving the date set
        // keeps it in the scheduler's polling window with only the gate stopping
        // it.
        ...(transition.unschedule ? { scheduled_date: null } : {}),
      },
    });

    await writeAudit(
      {
        entityType: "ContentItem",
        entityId: contentItemId,
        action: "edited",
        performedById: input.editedById,
        details: {
          from_status: previousStatus,
          to_status: transition.status,
          // Recorded, not the text itself: an audit row is a record of what
          // happened, and copying every draft into it would make the log a
          // second store of content.
          previous_length: existing.content_body?.length ?? 0,
          new_length: contentBody.length,
          unscheduled: transition.unschedule,
          reset_approvals: transition.status !== previousStatus,
        },
      },
      tx,
    );

    return {
      previousStatus,
      status: transition.status,
      unscheduled: transition.unschedule,
    };
  });

  return {
    contentItemId,
    previousStatus: written.previousStatus,
    status: written.status,
    unscheduled: written.unscheduled,
    resetApprovals: written.status !== written.previousStatus,
    gate: await canSchedule(contentItemId, db),
  };
}
