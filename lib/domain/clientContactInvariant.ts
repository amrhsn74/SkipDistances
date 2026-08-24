import { prisma, type Db } from "../db";
import { writeAudit } from "./auditLog";

/**
 * A `client_approver` User may hold exactly one `ClientAssignment` row, ever.
 *
 * This is a cross-client isolation rule, not bookkeeping. A client contact who
 * held approver rights on two clients could approve one client's content while
 * seeing another's — the exact leak the PRD forbids ("No client's content,
 * drafts, brand guide, or performance data is ever visible to another client's
 * team").
 *
 * Staff roles are deliberately the opposite: `content_lead` and
 * `content_creator` are many-to-many with Client, because one creator working
 * across several accounts is the normal case.
 *
 * Two names that are easy to conflate and mean different things:
 *
 *   User.user_type              = "client_contact"   — what kind of person
 *   ClientAssignment.role_on_client = "client_approver" — what they do here
 *
 * The constraint is on the assignment role. Checking `user_type` instead would
 * pass every test while enforcing nothing, because the rule is about
 * assignments, not about people.
 *
 * Enforced twice on purpose: here, with an error a human can read, and by a
 * partial unique index on `(user_id) WHERE role_on_client = 'client_approver'`
 * so a direct insert elsewhere cannot bypass it either.
 */

export const CLIENT_APPROVER_ROLE = "client_approver";

/** Staff roles, intentionally many-to-many with Client. */
export const MULTI_CLIENT_ROLES = ["content_lead", "content_creator"] as const;

export class SingleClientApproverError extends Error {
  readonly code = "SINGLE_CLIENT_APPROVER";
  readonly userId: string;
  readonly existingClientId: string;
  readonly attemptedClientId: string;

  constructor(userId: string, existingClientId: string, attemptedClientId: string) {
    super(
      `User ${userId} is already the client approver for ${existingClientId} and cannot also be assigned to ${attemptedClientId}. ` +
        `A client approver may hold exactly one assignment, so that one client's contact never gains rights over another client's content.`,
    );
    this.name = "SingleClientApproverError";
    this.userId = userId;
    this.existingClientId = existingClientId;
    this.attemptedClientId = attemptedClientId;
  }
}

/** The user's existing approver assignment, or null. */
export async function existingApproverAssignment(userId: string, db: Db = prisma) {
  return db.clientAssignment.findFirst({
    where: { user_id: userId, role_on_client: CLIENT_APPROVER_ROLE },
  });
}

/**
 * Whether this user could be made client approver for this client.
 *
 * Re-assigning them to the client they already approve for is not a violation:
 * it is a no-op, and treating it as an error would make an idempotent seed or a
 * double-submitted form fail for no reason.
 */
export async function canAssignClientApprover(
  clientId: string,
  userId: string,
  db: Db = prisma,
): Promise<{ allowed: boolean; existingClientId?: string }> {
  const existing = await existingApproverAssignment(userId, db);

  if (!existing) return { allowed: true };
  if (existing.client_id === clientId) return { allowed: true };

  return { allowed: false, existingClientId: existing.client_id };
}

export type AssignClientApproverInput = {
  clientId: string;
  userId: string;
  /** Who performed the assignment, for the audit trail. */
  performedById?: string | null;
};

/**
 * Assign a client approver, enforcing the invariant.
 *
 * Throws {@link SingleClientApproverError} when the user already approves for a
 * different client. Returns the existing row unchanged when they already
 * approve for this one.
 */
export async function assignClientApprover(
  input: AssignClientApproverInput,
  db: Db = prisma,
) {
  const { clientId, userId, performedById = null } = input;

  const existing = await existingApproverAssignment(userId, db);

  if (existing) {
    if (existing.client_id === clientId) return existing;
    throw new SingleClientApproverError(userId, existing.client_id, clientId);
  }

  const created = await db.clientAssignment.create({
    data: { client_id: clientId, user_id: userId, role_on_client: CLIENT_APPROVER_ROLE },
  });

  await writeAudit(
    {
      entityType: "ClientAssignment",
      entityId: created.assignment_id,
      action: "created",
      performedById,
      details: { client_id: clientId, user_id: userId, role_on_client: CLIENT_APPROVER_ROLE },
    },
    db,
  );

  return created;
}

/**
 * Every user currently holding more than one approver assignment.
 *
 * Should always be empty. Kept as a check the Phase 11 admin view and the
 * Phase 12 evaluation can run against real data, rather than trusting that the
 * constraint was never circumvented.
 */
export async function findApproverInvariantViolations(db: Db = prisma) {
  const rows = await db.clientAssignment.findMany({
    where: { role_on_client: CLIENT_APPROVER_ROLE },
    select: { user_id: true, client_id: true },
  });

  const byUser = new Map<string, string[]>();
  for (const r of rows) {
    byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r.client_id]);
  }

  return Array.from(byUser.entries())
    .filter(([, clientIds]) => clientIds.length > 1)
    .map(([userId, clientIds]) => ({ userId, clientIds }));
}
