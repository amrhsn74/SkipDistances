import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { ContentEditValidationError, editDraft } from "@/domain/contentEdit";
import { enforce } from "@/domain/permissions";
import { submitForReview } from "@/domain/submitForReview";
import { prisma } from "@/db";

/**
 * Editing one content item, over HTTP.
 *
 * The same shell as the other Phase 4 routes -- resolve who is asking, check the
 * capability, hand the work to the domain layer, map a thrown error to a status.
 *
 * Two actions on one route, distinguished by an `action` field rather than by
 * separate paths, because they are the same resource being changed by the same
 * person in the same sitting: save what I wrote, and hand it on. A `/submit`
 * path of its own would suggest submitting is a different kind of operation than
 * saving, when the only real difference is which transition cause runs.
 *
 * **A save runs the identical invalidation a regeneration does.** `editDraft`
 * calls `applyTransition` with `content_edit`, exactly as `regenerateItem` does,
 * so an edit to an approved post resets it to `drafted` and both stages clear
 * again. One rule, no per-cause branching -- and no route-level shortcut for
 * "it was only a small change".
 */

// Reads the session cookie and writes. Never cached.
export const dynamic = "force-dynamic";

/**
 * PATCH /api/content-items/[id]
 *
 * `{ content_body }` saves new text. `{ action: "submit" }` sends the draft to
 * internal review. Both answer 200 with the resulting status, so a caller can
 * see what its change actually did -- an edit that reset an approved item
 * reports `drafted`, which is the whole point of the reply.
 */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();

    const contentItemId = params.id;

    const body = (await request.json()) as Record<string, unknown>;

    // The capability is client-scoped, so the item has to be resolved to its
    // client before the check can mean anything. An unknown item is passed
    // through as an undefined client and denied by scope, which is the correct
    // answer: a caller must not learn from the status code whether an item they
    // cannot see happens to exist.
    const clientId = await clientOf(contentItemId);

    await enforce(user, "content.edit_draft", { clientId: clientId ?? undefined });

    if (asString(body.action) === "submit") {
      const submitted = await submitForReview(contentItemId, user.user_id);
      return NextResponse.json({
        content_item_id: submitted.contentItemId,
        previous_status: submitted.previousStatus,
        status: submitted.status,
      });
    }

    const contentBody = body.content_body ?? body.contentBody;
    if (typeof contentBody !== "string") {
      throw new ContentEditValidationError({
        contentBody: "Send the new draft text as `content_body`.",
      });
    }

    const result = await editDraft(contentItemId, {
      contentBody,
      editedById: user.user_id,
    });

    return NextResponse.json({
      content_item_id: result.contentItemId,
      previous_status: result.previousStatus,
      status: result.status,
      unscheduled: result.unscheduled,
      // What the caller most needs to know: whether this edit just cost the item
      // approvals it already had. The screen says so rather than letting a
      // creator discover it from a status badge they were not watching.
      reset_approvals: result.resetApprovals,
      gate: { allowed: result.gate.allowed, blocked_by: result.gate.blockedBy },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** The client this item belongs to, or null if there is no such item. */
async function clientOf(contentItemId: string): Promise<string | null> {
  const item = await prisma.contentItem.findUnique({
    where: { content_item_id: contentItemId },
    select: { campaign: { select: { client_id: true } } },
  });
  return item?.campaign.client_id ?? null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
