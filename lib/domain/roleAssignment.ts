import { prisma, type Db } from "../db";
import { writeAudit } from "./auditLog";
import {
  CLIENT_APPROVER_ROLE,
  SingleClientApproverError,
} from "./clientContactInvariant";

/**
 * The Admin's actual power: who works on what.
 *
 * The PRD gives the Agency Admin no dedicated user-management screen — they
 * "edit the fields directly on a client record". This module is what those edits
 * call. Everything here does three things without exception:
 *
 *   1. Rejects a non-admin caller. Authorisation lives on the write path, not in
 *      the route that happens to call it, so a new endpoint cannot forget it.
 *   2. Writes an `AuditLog` row naming who changed what, from what, to what.
 *      Reassignment without a trail is indistinguishable from an intrusion.
 *   3. Re-checks the single-`client_approver` invariant rather than trusting the
 *      caller — the same rule the database's partial index enforces underneath.
 */

/** Roles assignable through `ClientAssignment`. */
export const ASSIGNABLE_ROLES = [
  "content_lead",
  "content_creator",
  CLIENT_APPROVER_ROLE,
] as const;

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export function isAssignableRole(role: string): role is AssignableRole {
  return (ASSIGNABLE_ROLES as readonly string[]).includes(role);
}

export class NotAuthorizedError extends Error {
  readonly code = "NOT_AUTHORIZED";
  readonly actorId: string;
  constructor(actorId: string, action: string) {
    super(`User ${actorId} is not an agency admin and cannot ${action}.`);
    this.name = "NotAuthorizedError";
    this.actorId = actorId;
  }
}

export class RoleAssignmentError extends Error {
  readonly code = "ROLE_ASSIGNMENT";
  constructor(message: string) {
    super(message);
    this.name = "RoleAssignmentError";
  }
}

/**
 * Every entry point starts here.
 *
 * Takes the id rather than a user object on purpose: the caller passing the
 * object it wants trusted is how authorisation checks get hollowed out. The row
 * is read fresh, so an admin flag revoked a moment ago takes effect now.
 */
async function requireAdmin(actorId: string, action: string, db: Db): Promise<void> {
  if (!actorId) throw new NotAuthorizedError("(anonymous)", action);

  const actor = await db.user.findUnique({ where: { user_id: actorId } });
  if (!actor) throw new NotAuthorizedError(actorId, action);
  if (actor.status !== "active") throw new NotAuthorizedError(actorId, action);
  if (!actor.is_agency_admin) throw new NotAuthorizedError(actorId, action);
}

async function requireClient(clientId: string, db: Db) {
  const client = await db.client.findUnique({ where: { client_id: clientId } });
  if (!client) throw new RoleAssignmentError(`No client ${clientId}.`);
  return client;
}

async function requireUser(userId: string, db: Db) {
  const user = await db.user.findUnique({ where: { user_id: userId } });
  if (!user) throw new RoleAssignmentError(`No user ${userId}.`);
  return user;
}

export type AssignRoleInput = {
  clientId: string;
  userId: string;
  role: AssignableRole | string;
  byAdminId: string;
};

/**
 * Put a user on a client in a role.
 *
 * Idempotent: re-assigning an existing pairing returns the existing row without
 * a second audit entry, so a double-submitted form does not litter the trail
 * with changes that did not happen.
 */
export async function assignRole(input: AssignRoleInput, db: Db = prisma) {
  const { clientId, userId, role, byAdminId } = input;

  await requireAdmin(byAdminId, `assign ${role} on ${clientId}`, db);

  if (!isAssignableRole(role)) {
    throw new RoleAssignmentError(
      `"${role}" is not an assignable role. Expected one of: ${ASSIGNABLE_ROLES.join(", ")}.`,
    );
  }

  await requireClient(clientId, db);
  const user = await requireUser(userId, db);

  // A staff member cannot be a client's approver, and a client contact cannot be
  // agency staff on an account. Mixing the two is how a contact would end up
  // with production rights over their own content.
  if (role === CLIENT_APPROVER_ROLE && user.user_type !== "client_contact") {
    throw new RoleAssignmentError(
      `User ${userId} is ${user.user_type}; only a client_contact may be a ${CLIENT_APPROVER_ROLE}.`,
    );
  }
  if (role !== CLIENT_APPROVER_ROLE && user.user_type !== "staff") {
    throw new RoleAssignmentError(
      `User ${userId} is ${user.user_type}; only staff may hold ${role}.`,
    );
  }

  const existing = await db.clientAssignment.findUnique({
    where: {
      client_id_user_id_role_on_client: {
        client_id: clientId,
        user_id: userId,
        role_on_client: role,
      },
    },
  });
  if (existing) return existing;

  // Re-checked here rather than trusted from the caller. The partial unique
  // index enforces it underneath too; this exists so the failure is an error a
  // human can read instead of a constraint violation.
  if (role === CLIENT_APPROVER_ROLE) {
    const held = await db.clientAssignment.findFirst({
      where: { user_id: userId, role_on_client: CLIENT_APPROVER_ROLE },
    });
    if (held && held.client_id !== clientId) {
      throw new SingleClientApproverError(userId, held.client_id, clientId);
    }
  }

  const created = await db.clientAssignment.create({
    data: { client_id: clientId, user_id: userId, role_on_client: role },
  });

  await writeAudit(
    {
      entityType: "ClientAssignment",
      entityId: created.assignment_id,
      action: "created",
      performedById: byAdminId,
      details: { client_id: clientId, user_id: userId, role_on_client: role },
    },
    db,
  );

  return created;
}

export type RemoveAssignmentInput = {
  clientId: string;
  userId: string;
  role: AssignableRole | string;
  byAdminId: string;
};

/**
 * Take a user off a client.
 *
 * Returns whether a row was actually removed. Removing something already gone is
 * not an error — but it writes no audit row either, because nothing changed.
 */
export async function removeAssignment(
  input: RemoveAssignmentInput,
  db: Db = prisma,
): Promise<boolean> {
  const { clientId, userId, role, byAdminId } = input;

  await requireAdmin(byAdminId, `remove ${role} on ${clientId}`, db);

  const existing = await db.clientAssignment.findUnique({
    where: {
      client_id_user_id_role_on_client: {
        client_id: clientId,
        user_id: userId,
        role_on_client: role,
      },
    },
  });
  if (!existing) return false;

  await db.clientAssignment.delete({
    where: { assignment_id: existing.assignment_id },
  });

  // The row is gone, so the trail is the only remaining record that the pairing
  // ever existed. It keeps the assignment_id so a reader can tie the removal to
  // the creation.
  await writeAudit(
    {
      entityType: "ClientAssignment",
      entityId: existing.assignment_id,
      action: "deleted",
      performedById: byAdminId,
      details: { client_id: clientId, user_id: userId, role_on_client: role },
    },
    db,
  );

  return true;
}

export type ReassignAccountManagerInput = {
  clientId: string;
  /** The incoming manager, or null to leave the client unmanaged. */
  userId: string | null;
  byAdminId: string;
};

/**
 * Change a client's account manager.
 *
 * Distinct from {@link assignRole} because the account manager is a column on
 * `Client`, not a `ClientAssignment` row — one manager per client, which the
 * schema enforces by shape rather than by a rule anyone must remember.
 *
 * `userId: null` is permitted: CL-109 in the seeded roster is a real former
 * client with no manager, so "unmanaged" is a state the system already has to
 * represent rather than an edge case to reject.
 */
export async function reassignAccountManager(
  input: ReassignAccountManagerInput,
  db: Db = prisma,
) {
  const { clientId, userId, byAdminId } = input;

  await requireAdmin(byAdminId, `reassign the account manager on ${clientId}`, db);

  const client = await requireClient(clientId, db);

  if (userId !== null) {
    const user = await requireUser(userId, db);
    if (user.user_type !== "staff") {
      throw new RoleAssignmentError(
        `User ${userId} is ${user.user_type}; only staff may manage an account.`,
      );
    }
    if (user.status !== "active") {
      throw new RoleAssignmentError(
        `User ${userId} is ${user.status} and cannot take on an account.`,
      );
    }
  }

  const previousId = client.account_manager_id;
  if (previousId === userId) return client;

  const updated = await db.client.update({
    where: { client_id: clientId },
    data: { account_manager_id: userId },
  });

  // Both ends recorded. "Who has this account now" is answerable from the row;
  // "who lost it, and when" is only answerable from here.
  await writeAudit(
    {
      entityType: "Client",
      entityId: clientId,
      action: "edited",
      performedById: byAdminId,
      details: {
        field: "account_manager_id",
        from: previousId,
        to: userId,
      },
    },
    db,
  );

  return updated;
}

/** The current team on a client, for the Admin's inline editor in `P11.2`. */
export async function clientTeam(clientId: string, db: Db = prisma) {
  const client = await requireClient(clientId, db);

  const assignments = await db.clientAssignment.findMany({
    where: { client_id: clientId },
    include: { user: { select: { user_id: true, name: true, email: true } } },
    orderBy: { role_on_client: "asc" },
  });

  return {
    clientId,
    accountManagerId: client.account_manager_id,
    contentLeads: assignments.filter((a) => a.role_on_client === "content_lead"),
    contentCreators: assignments.filter((a) => a.role_on_client === "content_creator"),
    clientApprovers: assignments.filter((a) => a.role_on_client === CLIENT_APPROVER_ROLE),
  };
}
