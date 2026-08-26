import { prisma, type Db } from "../db";
import { ContentItemNotFoundError } from "./approvals";
import { writeAudit } from "./auditLog";
import { ContentEditNotAllowedError } from "./contentEdit";
import { applyTransition, type ContentStatus } from "./statusMachine";

/**
 * Handing a draft to the internal reviewer.
 *
 * The deliberate act that the reset to `drafted` exists to require. From the
 * architecture: a declined or edited item "goes back to whoever is working on it
 * to be fixed, and re-enters review only when someone deliberately resubmits
 * it". This is that resubmission -- and it is why editing does not submit, and
 * why a decline resets to `drafted` rather than back into the reviewer's queue.
 *
 * Its own module rather than a second function in `contentEdit.ts` because it is
 * a different cause with a different meaning. `content_edit` invalidates;
 * `submit_for_review` advances. Putting both behind one function would need a
 * parameter choosing between them, which is the shape a bug takes when someone
 * later passes the wrong one.
 */

export type SubmitResult = {
  contentItemId: string;
  previousStatus: ContentStatus;
  status: ContentStatus;
};

/**
 * Move a draft to `pending_internal_review`.
 *
 * Refuses anything the transition table refuses -- an item already in review, or
 * one that is approved, scheduled or live.
 *
 * A `flagged` item is submitted in **two** movements, not one: `resolve_flag`
 * clears it to `drafted`, then `submit_for_review` sends it on. The table refuses
 * `flagged -> pending_internal_review` directly, and that refusal is worth
 * keeping rather than widening -- it is what makes clearing a flag a recorded
 * act with its own audit row, instead of something that happens invisibly inside
 * a submit. Both movements run in one transaction here, so a creator still
 * presses one button.
 */
export async function submitForReview(
  contentItemId: string,
  submittedById: string,
  db: Db = prisma,
): Promise<SubmitResult> {
  return db.$transaction(async (tx) => {
    const existing = await tx.contentItem.findUnique({
      where: { content_item_id: contentItemId },
      select: { content_item_id: true, status: true, content_body: true },
    });

    if (!existing) throw new ContentItemNotFoundError(contentItemId);

    const previousStatus = existing.status as ContentStatus;

    // A flagged item is cleared first. The table refuses the direct hop on
    // purpose; resolving is its own recorded movement, and this is where the
    // two are sequenced rather than merged.
    let working = previousStatus;
    let flagResolved = false;

    if (working === "flagged") {
      const resolved = applyTransition(working, { cause: "resolve_flag" });
      if (!resolved.ok) {
        throw new ContentEditNotAllowedError(
          resolved.reason ?? `Cannot clear the flag on an item that is ${working}.`,
          working,
        );
      }
      working = resolved.status;
      flagResolved = true;
    }

    const transition = applyTransition(working, { cause: "submit_for_review" });

    if (!transition.ok) {
      throw new ContentEditNotAllowedError(
        transition.reason ?? `Cannot submit an item that is ${previousStatus}.`,
        previousStatus,
      );
    }

    await tx.contentItem.update({
      where: { content_item_id: contentItemId },
      data: {
        status: transition.status,
        // A resubmitted item carries no flag forward. The flag described the
        // draft that was refused; keeping it on the fixed version would show a
        // reviewer a rule violation that may no longer be there.
        flagged_clause_id: null,
      },
    });

    await writeAudit(
      {
        entityType: "ContentItem",
        entityId: contentItemId,
        action: "edited",
        performedById: submittedById,
        details: {
          submitted_for_review: true,
          from_status: previousStatus,
          to_status: transition.status,
          // Named separately so the trail shows a flag was cleared, not merely
          // that a status moved past it.
          ...(flagResolved ? { flag_resolved: true } : {}),
        },
      },
      tx,
    );

    return { contentItemId, previousStatus, status: transition.status };
  });
}
