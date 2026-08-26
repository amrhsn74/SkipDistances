import { randomUUID } from "node:crypto";

import { prisma, type Db } from "../db";
import { clientScopeWhere, type ScopeUser } from "./accessScope";
import {
  recordDecision,
  type ApprovalDecision,
  type RecordDecisionResult,
} from "./approvals";
import type { ApprovalStage } from "./statusMachine";

/**
 * Approving a whole plan in one action.
 *
 * The shortcut the PRD allows for, stated exactly as the PRD states it: "each
 * post carries its own approval by default; approving a whole plan in one action
 * is an available shortcut, **not a different underlying record**."
 *
 * So this writes nothing of its own. It loops `recordDecision` -- the same
 * function one button press calls -- and stamps every resulting row with one
 * shared `bulk_action_id`. The gate never learns that a bulk action happened,
 * because from where the gate reads there is nothing different to see: N normal
 * approvals, each the most recent row for its item and stage.
 *
 * The id is a grouping label for the audit trail, so "who approved these eleven
 * items, and was it one decision or eleven" is answerable later. It grants
 * nothing.
 *
 * **Partial success is the honest outcome.** One item in a plan may have moved
 * since the screen was drawn -- edited back to `drafted`, declined by the other
 * stage, already published. Failing the whole batch because of it would mean a
 * reviewer's eleven good approvals are lost to one stale row, and re-running
 * would then double-write the ten that had succeeded. Each item is attempted
 * independently and the result names which failed and why.
 */

export class BulkApprovalValidationError extends Error {
  readonly code = "BULK_APPROVAL_VALIDATION";
  readonly issues: Record<string, string>;

  constructor(issues: Record<string, string>) {
    super(`Invalid bulk approval: ${Object.keys(issues).join(", ")}.`);
    this.name = "BulkApprovalValidationError";
    this.issues = issues;
  }
}

/** How many items one action may cover. */
export const MAX_BULK_ITEMS = 100;

export type BulkDecisionInput = {
  contentItemIds: string[];
  stage: ApprovalStage;
  decision: ApprovalDecision;
  comment?: string | null;
  decidedById: string;
};

export type BulkItemOutcome =
  | { content_item_id: string; ok: true; status: string; gate_allowed: boolean }
  | { content_item_id: string; ok: false; code: string; message: string };

export type BulkDecisionResult = {
  bulk_action_id: string;
  stage: ApprovalStage;
  decision: ApprovalDecision;
  succeeded: number;
  failed: number;
  outcomes: BulkItemOutcome[];
};

/**
 * Record the same decision on many items, grouped under one id.
 *
 * `user` is the caller, used to scope which items are even addressable. The ids
 * come from the browser, so an id outside the caller's scope is dropped before
 * anything is written -- not refused with an error, which would tell a prober
 * that an item they cannot see exists. It is reported as a failure with the same
 * shape as any other, saying only that it was not available.
 *
 * The per-item capability check stays with the caller (`enforce` in the route),
 * because it is one capability for the whole action: a reviewer either may
 * decide at this stage on these clients or may not.
 */
export async function recordBulkDecision(
  user: ScopeUser,
  input: BulkDecisionInput,
  db: Db = prisma,
): Promise<BulkDecisionResult> {
  const issues: Record<string, string> = {};

  const requested = [...new Set((input.contentItemIds ?? []).filter((id) => typeof id === "string" && id !== ""))];

  if (requested.length === 0) {
    issues.contentItemIds = "Select at least one item to decide on.";
  } else if (requested.length > MAX_BULK_ITEMS) {
    issues.contentItemIds = `One action covers at most ${MAX_BULK_ITEMS} items.`;
  }

  if (Object.keys(issues).length > 0) throw new BulkApprovalValidationError(issues);

  // Scope first. An id the caller may not see never reaches `recordDecision`,
  // so a bulk action cannot become the wide door that the single-item endpoint
  // is careful not to be.
  const scope = await clientScopeWhere(user, db);
  const visible = await db.contentItem.findMany({
    where: { content_item_id: { in: requested }, campaign: { is: scope } },
    select: { content_item_id: true },
  });
  const addressable = new Set(visible.map((v) => v.content_item_id));

  const bulkActionId = randomUUID();

  const outcomes: BulkItemOutcome[] = [];

  // Sequential rather than parallel. Each `recordDecision` opens its own
  // transaction, and SQLite serialises writers anyway -- firing them at once
  // buys nothing and turns a lock timeout into a failure mode that only appears
  // under load.
  for (const contentItemId of requested) {
    if (!addressable.has(contentItemId)) {
      outcomes.push({
        content_item_id: contentItemId,
        ok: false,
        code: "NOT_AVAILABLE",
        message: "That item is no longer available to decide on.",
      });
      continue;
    }

    try {
      const result: RecordDecisionResult = await recordDecision(
        contentItemId,
        {
          stage: input.stage,
          decision: input.decision,
          comment: input.comment ?? null,
          decidedById: input.decidedById,
          bulkActionId,
        },
        db,
      );

      outcomes.push({
        content_item_id: contentItemId,
        ok: true,
        status: result.status,
        gate_allowed: result.gate.allowed,
      });
    } catch (error) {
      // One stale row must not lose a reviewer's other ten decisions. The
      // failure is reported per item, with the domain layer's own message --
      // "cannot decline an item that is published" is exactly what the screen
      // should say.
      outcomes.push({
        content_item_id: contentItemId,
        ok: false,
        code: codeOf(error),
        message: error instanceof Error ? error.message : "That decision could not be recorded.",
      });
    }
  }

  const succeeded = outcomes.filter((o) => o.ok).length;

  return {
    bulk_action_id: bulkActionId,
    stage: input.stage,
    decision: input.decision,
    succeeded,
    failed: outcomes.length - succeeded,
    outcomes,
  };
}

/** The domain error's own code, where it has one. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : "INTERNAL";
}
