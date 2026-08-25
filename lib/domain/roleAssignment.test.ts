import { describe, it, expect, beforeEach, afterAll } from "vitest";

import { prisma } from "../db";
import { SingleClientApproverError } from "./clientContactInvariant";
import {
  NotAuthorizedError,
  RoleAssignmentError,
  assignRole,
  clientTeam,
  reassignAccountManager,
  removeAssignment,
} from "./roleAssignment";

/**
 * The Admin's power, and its limits. Three things every entry point must do:
 * refuse a non-admin, leave an audit trail, and re-check the single-approver
 * invariant rather than trusting the caller.
 *
 * The authorisation tests matter most. A function that does the right thing for
 * an admin but also for everyone else is not an admin function.
 */

const ADMIN = "TEST-RA-ADMIN";
const STAFF = "TEST-RA-STAFF";
const STAFF_TWO = "TEST-RA-STAFF-2";
const CONTACT = "TEST-RA-CONTACT";
const CONTACT_TWO = "TEST-RA-CONTACT-2";
const USERS = [ADMIN, STAFF, STAFF_TWO, CONTACT, CONTACT_TWO];

const CLIENT_A = "CL-101";
const CLIENT_B = "CL-102";

let originalManagerA: string | null = null;

async function auditFor(entityId: string) {
  return prisma.auditLog.findMany({
    where: { entity_id: entityId },
    orderBy: { performed_at: "desc" },
  });
}

async function clearTestAssignments() {
  await prisma.clientAssignment.deleteMany({ where: { user_id: { in: USERS } } });
  // By actor, not by entity id: a previous test's `removeAssignment` deletes the
  // assignment row, so its audit entries can no longer be found by looking up
  // ids that still exist. Every row these tests write names a test user.
  await prisma.auditLog.deleteMany({ where: { performed_by_id: { in: USERS } } });
}

beforeEach(async () => {
  await clearTestAssignments();

  const people: [string, string, string, boolean][] = [
    [ADMIN, "Test RA Admin", "staff", true],
    [STAFF, "Test RA Staff", "staff", false],
    [STAFF_TWO, "Test RA Staff Two", "staff", false],
    [CONTACT, "Test RA Contact", "client_contact", false],
    [CONTACT_TWO, "Test RA Contact Two", "client_contact", false],
  ];

  for (const [id, name, type, isAdmin] of people) {
    await prisma.user.upsert({
      where: { user_id: id },
      update: { status: "active", is_agency_admin: isAdmin, user_type: type },
      create: {
        user_id: id,
        name,
        email: `${id.toLowerCase()}@skipstudio.test`,
        user_type: type,
        is_agency_admin: isAdmin,
      },
    });
  }

  if (originalManagerA === null) {
    const c = await prisma.client.findUniqueOrThrow({ where: { client_id: CLIENT_A } });
    originalManagerA = c.account_manager_id;
  }
  await prisma.client.update({
    where: { client_id: CLIENT_A },
    data: { account_manager_id: originalManagerA },
  });
});

afterAll(async () => {
  await clearTestAssignments();
  await prisma.client.update({
    where: { client_id: CLIENT_A },
    data: { account_manager_id: originalManagerA },
  });
  await prisma.user.deleteMany({ where: { user_id: { in: USERS } } });
});

describe("authorisation", () => {
  it("refuses every entry point to a non-admin", async () => {
    for (const caller of [STAFF, CONTACT]) {
      await expect(
        assignRole({ clientId: CLIENT_A, userId: STAFF, role: "content_creator", byAdminId: caller }),
      ).rejects.toThrow(NotAuthorizedError);

      await expect(
        removeAssignment({ clientId: CLIENT_A, userId: STAFF, role: "content_creator", byAdminId: caller }),
      ).rejects.toThrow(NotAuthorizedError);

      await expect(
        reassignAccountManager({ clientId: CLIENT_A, userId: STAFF, byAdminId: caller }),
      ).rejects.toThrow(NotAuthorizedError);
    }
  });

  it("refuses an unknown or anonymous caller", async () => {
    for (const caller of ["", "NO-SUCH-USER"]) {
      await expect(
        assignRole({ clientId: CLIENT_A, userId: STAFF, role: "content_creator", byAdminId: caller }),
      ).rejects.toThrow(NotAuthorizedError);
    }
  });

  it("refuses an admin whose account is disabled", async () => {
    await prisma.user.update({ where: { user_id: ADMIN }, data: { status: "disabled" } });

    // Read fresh on every call, so revoking an admin takes effect immediately
    // rather than at some later reload.
    await expect(
      assignRole({ clientId: CLIENT_A, userId: STAFF, role: "content_creator", byAdminId: ADMIN }),
    ).rejects.toThrow(NotAuthorizedError);
  });

  it("changes nothing when it refuses", async () => {
    await expect(
      assignRole({ clientId: CLIENT_A, userId: STAFF, role: "content_creator", byAdminId: STAFF }),
    ).rejects.toThrow(NotAuthorizedError);

    expect(
      await prisma.clientAssignment.count({ where: { user_id: STAFF } }),
    ).toBe(0);
  });
});

describe("assignRole", () => {
  it("assigns a staff member and records who did it", async () => {
    const created = await assignRole({
      clientId: CLIENT_A,
      userId: STAFF,
      role: "content_creator",
      byAdminId: ADMIN,
    });

    expect(created.client_id).toBe(CLIENT_A);
    expect(created.role_on_client).toBe("content_creator");

    const audit = await auditFor(created.assignment_id);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("created");
    expect(audit[0].performed_by_id).toBe(ADMIN);
    expect(JSON.parse(audit[0].details!)).toMatchObject({
      client_id: CLIENT_A,
      user_id: STAFF,
      role_on_client: "content_creator",
    });
  });

  it("is idempotent, and does not double-write the trail", async () => {
    const first = await assignRole({
      clientId: CLIENT_A, userId: STAFF, role: "content_creator", byAdminId: ADMIN,
    });
    const second = await assignRole({
      clientId: CLIENT_A, userId: STAFF, role: "content_creator", byAdminId: ADMIN,
    });

    expect(second.assignment_id).toBe(first.assignment_id);
    // A double-submitted form must not litter the trail with a change that did
    // not happen.
    expect(await auditFor(first.assignment_id)).toHaveLength(1);
  });

  it("rejects a role that is not assignable", async () => {
    for (const role of ["account_manager", "agency_admin", "admin", ""]) {
      await expect(
        assignRole({ clientId: CLIENT_A, userId: STAFF, role, byAdminId: ADMIN }),
        role,
      ).rejects.toThrow(RoleAssignmentError);
    }
  });

  it("rejects an unknown client or user", async () => {
    await expect(
      assignRole({ clientId: "CL-999", userId: STAFF, role: "content_creator", byAdminId: ADMIN }),
    ).rejects.toThrow(RoleAssignmentError);

    await expect(
      assignRole({ clientId: CLIENT_A, userId: "NOBODY", role: "content_creator", byAdminId: ADMIN }),
    ).rejects.toThrow(RoleAssignmentError);
  });

  it("keeps staff roles and the approver role apart", async () => {
    // A client contact with production rights, or a staff member holding the
    // client's own approval, would each break the two-stage gate's meaning.
    await expect(
      assignRole({ clientId: CLIENT_A, userId: CONTACT, role: "content_creator", byAdminId: ADMIN }),
    ).rejects.toThrow(RoleAssignmentError);

    await expect(
      assignRole({ clientId: CLIENT_A, userId: STAFF, role: "client_approver", byAdminId: ADMIN }),
    ).rejects.toThrow(RoleAssignmentError);
  });

  it("rejects a second client_approver assignment on the write path", async () => {
    await assignRole({
      clientId: CLIENT_A, userId: CONTACT, role: "client_approver", byAdminId: ADMIN,
    });

    // The invariant is re-checked here rather than trusted from the caller --
    // one contact approving for two clients is the cross-client leak itself.
    await expect(
      assignRole({ clientId: CLIENT_B, userId: CONTACT, role: "client_approver", byAdminId: ADMIN }),
    ).rejects.toThrow(SingleClientApproverError);

    expect(
      await prisma.clientAssignment.count({
        where: { user_id: CONTACT, role_on_client: "client_approver" },
      }),
    ).toBe(1);
  });

  it("allows two different contacts to approve for two different clients", async () => {
    await assignRole({ clientId: CLIENT_A, userId: CONTACT, role: "client_approver", byAdminId: ADMIN });
    await assignRole({ clientId: CLIENT_B, userId: CONTACT_TWO, role: "client_approver", byAdminId: ADMIN });

    expect(
      await prisma.clientAssignment.count({
        where: { user_id: { in: [CONTACT, CONTACT_TWO] }, role_on_client: "client_approver" },
      }),
    ).toBe(2);
  });

  it("allows one staff member across several clients", async () => {
    // The deliberate opposite of the approver rule: a creator working on
    // several accounts is the normal case.
    await assignRole({ clientId: CLIENT_A, userId: STAFF, role: "content_creator", byAdminId: ADMIN });
    await assignRole({ clientId: CLIENT_B, userId: STAFF, role: "content_creator", byAdminId: ADMIN });

    expect(await prisma.clientAssignment.count({ where: { user_id: STAFF } })).toBe(2);
  });
});

describe("removeAssignment", () => {
  it("removes the row and records the removal", async () => {
    const created = await assignRole({
      clientId: CLIENT_A, userId: STAFF, role: "content_creator", byAdminId: ADMIN,
    });

    expect(
      await removeAssignment({
        clientId: CLIENT_A, userId: STAFF, role: "content_creator", byAdminId: ADMIN,
      }),
    ).toBe(true);

    expect(
      await prisma.clientAssignment.findUnique({ where: { assignment_id: created.assignment_id } }),
    ).toBeNull();

    // The row is gone; the trail is the only remaining record it ever existed.
    const audit = await auditFor(created.assignment_id);
    expect(audit.map((a) => a.action)).toEqual(["deleted", "created"]);
    expect(audit[0].performed_by_id).toBe(ADMIN);
  });

  it("reports false for a pairing that was not there, and writes nothing", async () => {
    expect(
      await removeAssignment({
        clientId: CLIENT_A, userId: STAFF, role: "content_creator", byAdminId: ADMIN,
      }),
    ).toBe(false);

    expect(
      await prisma.auditLog.count({
        where: { performed_by_id: ADMIN, entity_type: "ClientAssignment" },
      }),
    ).toBe(0);
  });

  it("frees a contact to approve elsewhere once removed", async () => {
    await assignRole({ clientId: CLIENT_A, userId: CONTACT, role: "client_approver", byAdminId: ADMIN });
    await removeAssignment({ clientId: CLIENT_A, userId: CONTACT, role: "client_approver", byAdminId: ADMIN });

    // Moving a contact between clients must be possible -- the invariant is
    // "one at a time", not "one forever".
    await expect(
      assignRole({ clientId: CLIENT_B, userId: CONTACT, role: "client_approver", byAdminId: ADMIN }),
    ).resolves.toBeTruthy();
  });
});

describe("reassignAccountManager", () => {
  it("moves the account and records both ends of the change", async () => {
    const before = await prisma.client.findUniqueOrThrow({ where: { client_id: CLIENT_A } });

    await reassignAccountManager({ clientId: CLIENT_A, userId: STAFF, byAdminId: ADMIN });

    const after = await prisma.client.findUniqueOrThrow({ where: { client_id: CLIENT_A } });
    expect(after.account_manager_id).toBe(STAFF);

    const audit = (await auditFor(CLIENT_A)).filter((a) => a.performed_by_id === ADMIN);
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("edited");

    // "Who has this account now" is on the row; "who lost it" only exists here.
    expect(JSON.parse(audit[0].details!)).toEqual({
      field: "account_manager_id",
      from: before.account_manager_id,
      to: STAFF,
    });
  });

  it("accepts null, leaving the client unmanaged", async () => {
    // CL-109 in the seeded roster is a real former client with no manager, so
    // unmanaged is a state the system already represents.
    await reassignAccountManager({ clientId: CLIENT_A, userId: null, byAdminId: ADMIN });

    const after = await prisma.client.findUniqueOrThrow({ where: { client_id: CLIENT_A } });
    expect(after.account_manager_id).toBeNull();
  });

  it("writes nothing when the manager is unchanged", async () => {
    await reassignAccountManager({ clientId: CLIENT_A, userId: STAFF, byAdminId: ADMIN });
    await reassignAccountManager({ clientId: CLIENT_A, userId: STAFF, byAdminId: ADMIN });

    const audit = (await auditFor(CLIENT_A)).filter((a) => a.performed_by_id === ADMIN);
    expect(audit).toHaveLength(1);
  });

  it("refuses a client contact or a disabled user as manager", async () => {
    await expect(
      reassignAccountManager({ clientId: CLIENT_A, userId: CONTACT, byAdminId: ADMIN }),
    ).rejects.toThrow(RoleAssignmentError);

    await prisma.user.update({ where: { user_id: STAFF_TWO }, data: { status: "disabled" } });
    await expect(
      reassignAccountManager({ clientId: CLIENT_A, userId: STAFF_TWO, byAdminId: ADMIN }),
    ).rejects.toThrow(RoleAssignmentError);
  });
});

describe("clientTeam", () => {
  it("reports the current team, grouped by role", async () => {
    await reassignAccountManager({ clientId: CLIENT_A, userId: STAFF, byAdminId: ADMIN });
    await assignRole({ clientId: CLIENT_A, userId: STAFF_TWO, role: "content_creator", byAdminId: ADMIN });
    await assignRole({ clientId: CLIENT_A, userId: CONTACT, role: "client_approver", byAdminId: ADMIN });

    const team = await clientTeam(CLIENT_A);

    expect(team.accountManagerId).toBe(STAFF);
    expect(team.contentCreators.some((a) => a.user_id === STAFF_TWO)).toBe(true);
    expect(team.clientApprovers.map((a) => a.user_id)).toContain(CONTACT);
  });
});
