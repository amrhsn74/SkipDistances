import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { BulkApprovalValidationError, recordBulkDecision } from "@/domain/bulkApproval";
import { enforce } from "@/domain/permissions";
import { prisma } from "@/db";

/**
 * "Approve the whole plan", over HTTP.
 *
 * A collection route rather than a verb on one item, because the action is about
 * a set: one `bulk_action_id` stamped across N decisions. Everything underneath
 * is `recordDecision`, called once per item -- the shortcut is a grouping label,
 * not a different underlying record (PRD §6), so there is no second write path
 * for the gate to disagree with.
 *
 * The capability is checked **per distinct client** in the set, not once for the
 * request. A content lead's queue spans accounts, so a batch can legitimately
 * cover several clients -- and checking the first one and assuming the rest is
 * precisely how a scoped action becomes an unscoped one. Items outside scope are
 * dropped inside `recordBulkDecision` before that; this check is about the
 * capability, that one about visibility.
 */

// Reads the session cookie and writes. Never cached.
export const dynamic = "force-dynamic";

/** Statuses at which a decline is pulling back an approval already given. */
const ALREADY_APPROVED = new Set(["internal_approved", "client_approved", "scheduled"]);

/**
 * POST /api/approvals/bulk
 *
 * Accepts `{ content_item_ids[], stage, decision, comment? }`.
 *
 * Answers 200 rather than 201, and always with a per-item breakdown. A batch is
 * not all-or-nothing: an item that moved since the screen was drawn fails on its
 * own and the rest still land, so the response reports what happened to each
 * rather than a single status code that could only ever be a summary.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();

    const body = (await request.json()) as Record<string, unknown>;

    const stage = asString(body.stage);
    const decision = asString(body.decision);
    const contentItemIds = asStringArray(body.content_item_ids ?? body.contentItemIds);

    if (contentItemIds.length === 0) {
      throw new BulkApprovalValidationError({
        contentItemIds: "Select at least one item to decide on.",
      });
    }

    // Every client the batch touches, and the strictest capability any item in
    // it needs. Resolved from the items themselves rather than from the body,
    // for the same reason the single-item route does: a caller who could label
    // their own action would pick the label they hold the capability for.
    const items = await prisma.contentItem.findMany({
      where: { content_item_id: { in: contentItemIds } },
      select: { status: true, campaign: { select: { client_id: true } } },
    });

    const clientIds = [...new Set(items.map((i) => i.campaign.client_id))];
    const anyAlreadyApproved = items.some((i) => ALREADY_APPROVED.has(i.status));
    const capability = capabilityFor(stage, decision, anyAlreadyApproved);

    // An empty set means every id was unknown or invisible. Checked against
    // `undefined` so the denial is by scope, which is the answer that discloses
    // nothing about whether those items exist.
    if (clientIds.length === 0) {
      await enforce(user, capability, { clientId: undefined });
    }

    for (const clientId of clientIds) {
      await enforce(user, capability, { clientId });
    }

    const result = await recordBulkDecision(user, {
      contentItemIds,
      // Passed through unvalidated: `recordDecision` owns the vocabulary, and
      // duplicating the allowed values here is how a route and its domain
      // function end up disagreeing about what a stage is.
      stage: stage as "internal" | "client",
      decision: decision as "approve" | "decline",
      comment: optionalString(body.comment) ?? null,
      decidedById: user.user_id,
    });

    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Which capability this batch needs.
 *
 * The strictest one any item in the set requires. A batch containing one already
 * approved item is a late-revoke batch, and needs `approval.revoke` for all of
 * it -- taking the loosest would let a revoke ride along inside a batch of
 * ordinary declines.
 */
function capabilityFor(
  stage: string,
  decision: string,
  anyAlreadyApproved: boolean,
): "approval.internal" | "approval.client" | "approval.revoke" {
  if (decision === "decline" && anyAlreadyApproved) return "approval.revoke";
  return stage === "client" ? "approval.client" : "approval.internal";
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
