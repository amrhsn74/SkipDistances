import { describe, it, expect, beforeEach, afterAll } from "vitest";

import { prisma } from "../db";
import {
  CLIENT_APPROVER_ROLE,
  SingleClientApproverError,
  assignClientApprover,
  canAssignClientApprover,
  existingApproverAssignment,
  findApproverInvariantViolations,
} from "./clientContactInvariant";

/**
 * The invariant is a cross-client isolation rule: a client contact holding
 * approver rights on two clients could approve one client's content while
 * seeing another's.
 *
 * Note what is NOT tested by checking `user_type`. The constraint is on
 * ClientAssignment.role_on_client = "client_approver"; `client_contact` is the
 * User's type. Asserting the wrong one passes while enforcing nothing.
 */

const TEST_USER = "TEST-APPROVER-USER";
const TEST_STAFF = "TEST-STAFF-USER";

let clientA = "";
let clientB = "";

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { entity_type: "ClientAssignment" } });
  await prisma.clientAssignment.deleteMany({
    where: { user_id: { in: [TEST_USER, TEST_STAFF] } },
  });
}

beforeEach(async () => {
  const clients = await prisma.client.findMany({
    where: { status: "active" },
    select: { client_id: true },
    orderBy: { client_id: "asc" },
    take: 2,
  });
  clientA = clients[0].client_id;
  clientB = clients[1].client_id;

  await prisma.user.upsert({
    where: { user_id: TEST_USER },
    update: {},
    create: { user_id: TEST_USER, name: "Test Approver", user_type: "client_contact" },
  });
  await prisma.user.upsert({
    where: { user_id: TEST_STAFF },
    update: {},
    create: { user_id: TEST_STAFF, name: "Test Creator", user_type: "staff" },
  });

  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { user_id: { in: [TEST_USER, TEST_STAFF] } } });
  await prisma.$disconnect();
});

describe("assignClientApprover", () => {
  it("allows a first assignment", async () => {
    const row = await assignClientApprover({ clientId: clientA, userId: TEST_USER });

    expect(row.client_id).toBe(clientA);
    expect(row.role_on_client).toBe(CLIENT_APPROVER_ROLE);
  });

  it("rejects a second assignment to a different client", async () => {
    await assignClientApprover({ clientId: clientA, userId: TEST_USER });

    await expect(
      assignClientApprover({ clientId: clientB, userId: TEST_USER }),
    ).rejects.toThrow(SingleClientApproverError);
  });

  it("names both clients in the error, so the admin can see the conflict", async () => {
    await assignClientApprover({ clientId: clientA, userId: TEST_USER });

    try {
      await assignClientApprover({ clientId: clientB, userId: TEST_USER });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SingleClientApproverError);
      const err = e as SingleClientApproverError;
      expect(err.existingClientId).toBe(clientA);
      expect(err.attemptedClientId).toBe(clientB);
      expect(err.code).toBe("SINGLE_CLIENT_APPROVER");
    }
  });

  it("writes no row when it rejects", async () => {
    await assignClientApprover({ clientId: clientA, userId: TEST_USER });
    await expect(
      assignClientApprover({ clientId: clientB, userId: TEST_USER }),
    ).rejects.toThrow();

    const all = await prisma.clientAssignment.findMany({ where: { user_id: TEST_USER } });
    expect(all).toHaveLength(1);
    expect(all[0].client_id).toBe(clientA);
  });

  it("is idempotent for the client they already approve for", async () => {
    const first = await assignClientApprover({ clientId: clientA, userId: TEST_USER });
    const again = await assignClientApprover({ clientId: clientA, userId: TEST_USER });

    // Re-assigning to the same client is a no-op, not a violation: an
    // idempotent seed or a double-submitted form must not fail.
    expect(again.assignment_id).toBe(first.assignment_id);
    expect(await prisma.clientAssignment.count({ where: { user_id: TEST_USER } })).toBe(1);
  });

  it("audits the assignment", async () => {
    const row = await assignClientApprover({
      clientId: clientA,
      userId: TEST_USER,
      performedById: null,
    });

    const audit = await prisma.auditLog.findMany({
      where: { entity_type: "ClientAssignment", entity_id: row.assignment_id },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("created");
  });
});

describe("the database enforces it too", () => {
  it("rejects a direct insert that bypasses the domain function", async () => {
    // The domain check alone is not enough: any code calling prisma directly
    // would slip past it. A partial unique index makes the DB refuse as well.
    await assignClientApprover({ clientId: clientA, userId: TEST_USER });

    await expect(
      prisma.clientAssignment.create({
        data: {
          client_id: clientB,
          user_id: TEST_USER,
          role_on_client: CLIENT_APPROVER_ROLE,
        },
      }),
    ).rejects.toThrow();
  });
});

describe("staff roles stay many-to-many", () => {
  it("lets one content creator work across several clients", async () => {
    await prisma.clientAssignment.create({
      data: { client_id: clientA, user_id: TEST_STAFF, role_on_client: "content_creator" },
    });
    await prisma.clientAssignment.create({
      data: { client_id: clientB, user_id: TEST_STAFF, role_on_client: "content_creator" },
    });

    // The invariant is deliberately narrow -- one creator on several accounts
    // is the normal case, and constraining it would break the roster.
    expect(await prisma.clientAssignment.count({ where: { user_id: TEST_STAFF } })).toBe(2);
  });

  it("lets one content lead review for several clients", async () => {
    await prisma.clientAssignment.create({
      data: { client_id: clientA, user_id: TEST_STAFF, role_on_client: "content_lead" },
    });
    await prisma.clientAssignment.create({
      data: { client_id: clientB, user_id: TEST_STAFF, role_on_client: "content_lead" },
    });

    expect(await prisma.clientAssignment.count({ where: { user_id: TEST_STAFF } })).toBe(2);
  });

  it("constrains the assignment role, not the user type", async () => {
    // A client_contact User is not itself restricted -- only the approver
    // assignment is. Enforcing on user_type would be the wrong rule, and would
    // wrongly block this.
    await prisma.clientAssignment.create({
      data: { client_id: clientA, user_id: TEST_USER, role_on_client: "content_creator" },
    });
    await prisma.clientAssignment.create({
      data: { client_id: clientB, user_id: TEST_USER, role_on_client: "content_creator" },
    });

    expect(await prisma.clientAssignment.count({ where: { user_id: TEST_USER } })).toBe(2);

    // And the approver slot is still free.
    const check = await canAssignClientApprover(clientA, TEST_USER);
    expect(check.allowed).toBe(true);
  });
});

describe("canAssignClientApprover", () => {
  it("allows when the user has no approver assignment", async () => {
    expect(await canAssignClientApprover(clientA, TEST_USER)).toEqual({ allowed: true });
  });

  it("allows re-assignment to the same client", async () => {
    await assignClientApprover({ clientId: clientA, userId: TEST_USER });
    expect(await canAssignClientApprover(clientA, TEST_USER)).toEqual({ allowed: true });
  });

  it("refuses a different client and reports which one blocks it", async () => {
    await assignClientApprover({ clientId: clientA, userId: TEST_USER });

    const result = await canAssignClientApprover(clientB, TEST_USER);
    expect(result.allowed).toBe(false);
    expect(result.existingClientId).toBe(clientA);
  });
});

describe("existingApproverAssignment", () => {
  it("returns null when there is none", async () => {
    expect(await existingApproverAssignment(TEST_USER)).toBeNull();
  });

  it("ignores the user's staff-role assignments", async () => {
    await prisma.clientAssignment.create({
      data: { client_id: clientA, user_id: TEST_USER, role_on_client: "content_creator" },
    });

    expect(await existingApproverAssignment(TEST_USER)).toBeNull();
  });
});

describe("findApproverInvariantViolations", () => {
  it("finds nothing in the seeded roster", async () => {
    // The seed gives each hero client its own contact. If this ever fails, the
    // constraint was circumvented somewhere.
    expect(await findApproverInvariantViolations()).toHaveLength(0);
  });

  it("would report a violation if one existed", async () => {
    // Proving the detector detects needs a violation to exist, and neither the
    // domain function nor raw SQL can create one -- the partial index refuses
    // both, which is exactly what it is for.
    //
    // So: drop the index, insert, detect, and restore it, all inside one
    // transaction that is then rolled back. Without this the test would assert
    // only that violations are hard to create, never that they are noticed.
    await assignClientApprover({ clientId: clientA, userId: TEST_USER });

    const violations = await prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`DROP INDEX "ClientAssignment_single_client_approver"`);
        await tx.$executeRawUnsafe(
          `INSERT INTO "ClientAssignment" ("assignment_id","client_id","user_id","role_on_client","created_at")
           VALUES ('TEST-VIOLATION', ?, ?, ?, ?)`,
          clientB,
          TEST_USER,
          CLIENT_APPROVER_ROLE,
          new Date().toISOString(),
        );

        const found = await findApproverInvariantViolations(tx);

        // Force a rollback: the inserted row and the dropped index both go away.
        throw Object.assign(new Error("rollback"), { found });
      })
      .catch((e: { found?: Array<{ userId: string; clientIds: string[] }> }) => e.found ?? []);

    expect(violations).toHaveLength(1);
    expect(violations[0].userId).toBe(TEST_USER);
    expect(violations[0].clientIds.sort()).toEqual([clientA, clientB].sort());

    // The rollback must have restored the constraint, not left it dropped.
    await expect(
      prisma.clientAssignment.create({
        data: { client_id: clientB, user_id: TEST_USER, role_on_client: CLIENT_APPROVER_ROLE },
      }),
    ).rejects.toThrow();
  });
});
