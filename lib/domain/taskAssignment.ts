import { prisma, type Db } from "../db";
import { writeAudit } from "./auditLog";
import { enforce } from "./permissions";
import type { ScopeUser } from "./accessScope";

/**
 * Dispatching a produced item to the creator who will finish it.
 *
 * The content lead prompts the engine, then hands what comes out to someone.
 * That hand-off is this module, and it is deliberately thin: assignment is a
 * label saying who is expected to work on something, not a permission.
 *
 * What that means, precisely, because it is the thing most likely to be got
 * wrong later:
 *
 *   - Assignment does not widen visibility. `ClientAssignment` decides which
 *     clients a creator sees, and assigning an item to someone with no such row
 *     is refused here rather than quietly granting them a view of that client's
 *     work. If it granted access, it would be a second scoping rule running
 *     alongside `accessScope` -- and a second rule is a second thing that can
 *     disagree with the first.
 *   - Assignment gates nothing in the approval path. An unassigned item is still
 *     reviewable, still approvable, still publishable. The gate reads approvals
 *     (`gate.ts`); it has never read authorship and must not start.
 *   - Reassignment is not a status change. The item keeps its status and its
 *     approvals, because who is holding a draft says nothing about whether the
 *     draft is any good.
 *
 * Authorisation runs on this write path rather than in the route that calls it,
 * matching `roleAssignment.ts` -- so a second caller added later cannot forget
 * it.
 */

/** The `ClientAssignment.role_on_client` value an assignee must hold. */
const CREATOR_ROLE = "content_creator";

export class TaskAssignmentError extends Error {
  readonly code = "TASK_ASSIGNMENT";
  constructor(message: string) {
    super(message);
    this.name = "TaskAssignmentError";
  }
}

export class ContentItemNotFoundError extends Error {
  readonly code = "CONTENT_ITEM_NOT_FOUND";
  constructor(contentItemId: string) {
    super(`No content item ${contentItemId}.`);
    this.name = "ContentItemNotFoundError";
  }
}

export type AssignmentResult = {
  contentItemId: string;
  clientId: string;
  /** Null when the item was previously unassigned. */
  previousAssigneeId: string | null;
  /** Null when this call cleared the assignment. */
  assigneeId: string | null;
};

/**
 * Assign an item to a creator, or clear it by passing `null`.
 *
 * Clearing is the same operation rather than its own function: both answer "who
 * is expected to work on this", and the audit row that results reads the same
 * way either direction. Splitting them would need the caller to choose, which is
 * where the wrong choice gets made.
 */
export async function assignItem(
  actor: ScopeUser & { status?: string },
  contentItemId: string,
  assigneeId: string | null,
  db: Db = prisma,
): Promise<AssignmentResult> {
  const item = await db.contentItem.findUnique({
    where: { content_item_id: contentItemId },
    select: {
      content_item_id: true,
      assigned_to_id: true,
      campaign: { select: { client_id: true } },
    },
  });

  if (!item) throw new ContentItemNotFoundError(contentItemId);

  const clientId = item.campaign.client_id;

  // Capability and client scope together, and before anything is read about the
  // assignee -- a caller who may not dispatch for this client must not learn
  // from the error which creators it has.
  await enforce(actor, "task.assign", { clientId }, db);

  if (assigneeId !== null) {
    await assertCreatorOnClient(assigneeId, clientId, db);
  }

  const previousAssigneeId = item.assigned_to_id;

  // A no-op assignment writes no row. An audit trail that records "assigned to
  // the person it was already assigned to" is noise that makes the real
  // hand-offs harder to find.
  if (previousAssigneeId === assigneeId) {
    return { contentItemId, clientId, previousAssigneeId, assigneeId };
  }

  await db.contentItem.update({
    where: { content_item_id: contentItemId },
    data: { assigned_to_id: assigneeId },
  });

  await writeAudit(
    {
      entityType: "ContentItem",
      entityId: contentItemId,
      action: "assigned",
      performedById: actor.user_id,
      // From and to, both recorded: a reassignment is only legible if the trail
      // says who lost the work as well as who gained it.
      details: {
        client_id: clientId,
        from_assignee_id: previousAssigneeId,
        to_assignee_id: assigneeId,
      },
    },
    db,
  );

  return { contentItemId, clientId, previousAssigneeId, assigneeId };
}

/**
 * The assignee must actually be a creator on this client.
 *
 * Checked against `ClientAssignment` rather than against the user's global role,
 * because "is a creator somewhere" is not the question -- dispatching a Cairo
 * Roast item to a creator who works only on NileFit would hand them work they
 * cannot open, and the error would surface later as an empty screen rather than
 * here as a refusal.
 */
async function assertCreatorOnClient(userId: string, clientId: string, db: Db) {
  const assignment = await db.clientAssignment.findFirst({
    where: {
      user_id: userId,
      client_id: clientId,
      role_on_client: CREATOR_ROLE,
    },
    select: { assignment_id: true },
  });

  if (!assignment) {
    throw new TaskAssignmentError(
      `User ${userId} is not a content creator on client ${clientId}.`,
    );
  }
}
