import { prisma, type Db } from "../db";
import { ContentItemNotFoundError } from "./approvals";
import { writeAudit } from "./auditLog";
import { ContentEditNotAllowedError } from "./contentEdit";
import { raiseFlag } from "./misuse";
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
      select: {
        content_item_id: true,
        status: true,
        content_body: true,
        campaign_id: true,
        // Submitting a flagged item is the act that makes the violation worth
        // recording, and the clause is the whole substance of the record.
        // Read before it is cleared below.
        flagged_clause_id: true,
      },
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

    // --- The deferred content flag, raised now that someone stands behind it. ---
    //
    // `queueOrFlag` deliberately raises nothing when the engine declines to
    // draft something: a refusal the creator sees and abandons is not evidence
    // of anything, and recording it would fill the Admin's table with drafts
    // nobody ever submitted.
    //
    // Submitting is the act that changes that. A creator sending a flagged item
    // to review has read the refusal and asked for it anyway, and *that* is
    // worth keeping -- so the row is raised here, naming them, with the clause
    // they submitted past.
    if (flagResolved && existing.flagged_clause_id) {
      // `flagged_clause_id` is a bare column, not a relation, so the clause is
      // looked up rather than included. Which agency the rule belongs to decides
      // the flag type: an agency clause is a compliance violation, a brand one
      // is a brand violation.
      const clause = await tx.guidelineClause.findUnique({
        where: { clause_id: existing.flagged_clause_id },
        select: { clause_code: true, title: true, source_type: true },
      });

      await raiseFlag(
        {
          flagType:
            clause?.source_type === "agency" ? "compliance_violation" : "brand_violation",
          raisedAgainstId: submittedById,
          campaignId: existing.campaign_id,
          contentItemId,
          clauseId: existing.flagged_clause_id,
          details: {
            clause_code: clause?.clause_code ?? null,
            clause_title: clause?.title ?? null,
            // The distinction that makes the row actionable: this was not the
            // engine flagging a draft, it was a person submitting one anyway.
            submitted_despite_flag: true,
          },
        },
        tx,
      );
    }

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
