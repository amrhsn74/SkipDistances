import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { ApprovalValidationError, recordDecision } from "@/domain/approvals";
import { enforce } from "@/domain/permissions";
import { prisma } from "@/db";

/**
 * Review decisions over HTTP.
 *
 * The same shell as the other Phase 4 routes -- resolve who is asking, check the
 * capability, hand the work to the domain layer, map a thrown error to a status.
 * The status machine, the decline-comment rule, the unscheduling, the churn
 * signal and the audit row are all `recordDecision`'s; none of them is decided
 * here.
 *
 * **One endpoint serves approve, decline, and late-revoke.** They are the same
 * action at the domain layer -- a row in `Approval` and a re-run of the status
 * machine -- and the plan calls for exactly one endpoint over them. A separate
 * `/revoke` route would have to re-derive when a decline counts as a revoke, and
 * would be the obvious place for the two paths to drift apart on whether a
 * scheduled item gets unscheduled.
 *
 * What the route does add is the permission split, because a revoke is a
 * *different capability* even though it is the same operation: `approval.revoke`
 * is granted to the account manager, content lead and client, while
 * `approval.internal` and `approval.client` separate who may decide at which
 * stage. Which one applies depends on the item's current status, so it is
 * resolved from the item rather than from anything the caller sends.
 */

// Reads the session cookie and writes. Never cached.
export const dynamic = "force-dynamic";

/** Statuses at which a decline is pulling back an approval already given. */
const ALREADY_APPROVED = new Set(["internal_approved", "client_approved", "scheduled"]);

/**
 * POST /api/content-items/[id]/approvals
 *
 * Accepts `{ stage, decision, comment, decidedById }`. `decidedById` is read
 * from the body only to be checked against the session -- see `actorFor`.
 *
 * Answers 201: a decision is a new `Approval` row every time, including a
 * decline and including a re-approval of something declined earlier. Rows
 * accumulate rather than being overwritten, which is what makes the gate's
 * most-recent-per-stage reading possible at all.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();

    const contentItemId = params.id;

    const body = (await request.json()) as Record<string, unknown>;

    const stage = asString(body.stage);
    const decision = asString(body.decision);

    // The capability is client-scoped, so the item has to be resolved to its
    // client before the check can mean anything. An unknown item is passed
    // through as an undefined client and denied by scope, which is the correct
    // answer: a caller must not learn from the status code whether an item they
    // cannot see happens to exist.
    const item = await itemContext(contentItemId);

    await enforce(user, capabilityFor(stage, decision, item?.status), {
      clientId: item?.clientId,
    });

    const result = await recordDecision(contentItemId, {
      // Passed through unvalidated: `recordDecision` owns the vocabulary, and
      // duplicating the allowed values here is how a route and its domain
      // function end up disagreeing about what a stage is.
      stage: stage as "internal" | "client",
      decision: decision as "approve" | "decline",
      comment: optionalString(body.comment) ?? null,
      decidedById: actorFor(user.user_id, body.decidedById),
      bulkActionId: optionalString(body.bulk_action_id ?? body.bulkActionId) ?? null,
    });

    return NextResponse.json(
      {
        approval_id: result.approvalId,
        content_item_id: result.contentItemId,
        stage: result.stage,
        decision: result.decision,
        previous_status: result.previousStatus,
        status: result.status,
        unscheduled: result.unscheduled,
        late_revoke: result.lateRevoke,
        // What the gate says *after* this decision, so a review screen can show
        // "waiting on the client" without asking a second endpoint. Not a
        // licence to publish: the scheduler re-checks atomically at publish
        // time, and that check is the one that counts.
        gate: {
          allowed: result.gate.allowed,
          blocked_by: result.gate.blockedBy,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Which capability this decision needs.
 *
 * A decline at a status where an approval already stands is a late-revoke, and
 * needs `approval.revoke`. Anything else needs the capability for its stage.
 *
 * Resolved from the item's own status rather than from a body field, for the
 * same reason the acting user comes from the session: a caller who could label
 * their own action would pick whichever label they hold the capability for.
 *
 * An unknown stage falls back to `approval.internal`. That is not a guess about
 * intent -- it is the stricter of the two branches, and `recordDecision` refuses
 * the bad stage immediately afterwards with a field-keyed error. Choosing the
 * permissive branch here would let an unknown stage be the way to skip a check.
 */
function capabilityFor(
  stage: string,
  decision: string,
  status: string | undefined,
): "approval.internal" | "approval.client" | "approval.revoke" {
  if (decision === "decline" && status && ALREADY_APPROVED.has(status)) {
    return "approval.revoke";
  }
  return stage === "client" ? "approval.client" : "approval.internal";
}

/**
 * The user id recorded on the row.
 *
 * The plan's body shape includes `decidedById`, but a decision that trusted it
 * would let anyone attribute an approval to someone else -- and the gate reads
 * these rows as the record of who signed off. So it is accepted and checked: if
 * it names anyone but the signed-in user, the request is refused rather than
 * silently re-attributed, because a caller who sent a different id believes
 * something about this request that is not true.
 */
function actorFor(sessionUserId: string, supplied: unknown): string {
  if (typeof supplied === "string" && supplied !== "" && supplied !== sessionUserId) {
    throw new ApprovalValidationError({
      decidedById:
        "A decision is recorded against the signed-in user; it cannot name someone else.",
    });
  }
  return sessionUserId;
}

/** The client and status for this item, or undefined if there is no such item. */
async function itemContext(
  contentItemId: string,
): Promise<{ clientId: string; status: string } | undefined> {
  const item = await prisma.contentItem.findUnique({
    where: { content_item_id: contentItemId },
    select: { status: true, campaign: { select: { client_id: true } } },
  });

  if (!item) return undefined;
  return { clientId: item.campaign.client_id, status: item.status };
}

/**
 * Body coercion, kept deliberately dumb -- as on the other Phase 4 routes.
 *
 * A wrong type becomes an empty value rather than throwing, so the caller gets
 * `ApprovalValidationError`'s field-keyed message instead of a 500.
 */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
