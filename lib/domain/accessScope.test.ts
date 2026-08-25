import { describe, it, expect, beforeAll } from "vitest";

import { prisma } from "../db";
import {
  type ScopeUser,
  canAccessClient,
  clientScopeWhere,
  effectiveRole,
  seesAllClients,
  visibleClientIds,
  visibleClients,
} from "./accessScope";

/**
 * Driven against the seeded roster rather than fixtures, because the thing
 * being tested is whether real data is partitioned correctly. A synthetic
 * two-client setup would pass while the 150-client roster leaked.
 *
 * The counterpart is `P11.6`: cross-client visibility belongs to the content
 * lead and agency admin, and to nobody else.
 */

async function userByEmail(email: string): Promise<ScopeUser> {
  return prisma.user.findUniqueOrThrow({
    where: { email },
    select: { user_id: true, user_type: true, is_agency_admin: true },
  });
}

let admin: ScopeUser;
let lead: ScopeUser;
let creator: ScopeUser;
let accountManager: ScopeUser;
let otherAccountManager: ScopeUser;
let clientContact: ScopeUser;
let totalClients = 0;

beforeAll(async () => {
  admin = await userByEmail("hala.mansour@skipstudio.test");
  lead = await userByEmail("youssef.adel@skipstudio.test");
  creator = await userByEmail("mona.farid@skipstudio.test");
  clientContact = await userByEmail("rana.fouad@skipstudio.test");

  const managers = await prisma.client.findMany({
    where: { NOT: { account_manager_id: null } },
    select: { account_manager_id: true },
    distinct: ["account_manager_id"],
    orderBy: { account_manager_id: "asc" },
  });
  accountManager = await prisma.user.findUniqueOrThrow({
    where: { user_id: managers[0].account_manager_id! },
    select: { user_id: true, user_type: true, is_agency_admin: true },
  });
  otherAccountManager = await prisma.user.findUniqueOrThrow({
    where: { user_id: managers[1].account_manager_id! },
    select: { user_id: true, user_type: true, is_agency_admin: true },
  });

  totalClients = await prisma.client.count();
});

describe("effectiveRole", () => {
  it("derives each role from the User row and its assignments", async () => {
    expect(await effectiveRole(admin)).toBe("agency_admin");
    expect(await effectiveRole(lead)).toBe("content_lead");
    expect(await effectiveRole(creator)).toBe("content_creator");
    expect(await effectiveRole(accountManager)).toBe("account_manager");
    expect(await effectiveRole(clientContact)).toBe("client_contact");
  });

  it("treats the admin flag as overriding whatever assignments they hold", async () => {
    // An admin who is also assigned somewhere is still an admin; checking
    // assignments first would narrow them to that client.
    const withAssignment: ScopeUser = { ...admin, is_agency_admin: true };
    expect(await effectiveRole(withAssignment)).toBe("agency_admin");
  });

  it("gives a user who is both lead and creator the wider role", async () => {
    // Someone can hold both kinds of assignment. The wider scope must win --
    // the reverse would silently strip a lead of cross-client visibility.
    const both = await prisma.user.findFirstOrThrow({
      where: { email: "youssef.adel@skipstudio.test" },
      select: { user_id: true, user_type: true, is_agency_admin: true },
    });
    const created = await prisma.clientAssignment.create({
      data: { client_id: "CL-101", user_id: both.user_id, role_on_client: "content_creator" },
    });

    try {
      expect(await effectiveRole(both)).toBe("content_lead");
    } finally {
      await prisma.clientAssignment.delete({
        where: { assignment_id: created.assignment_id },
      });
    }
  });
});

describe("content lead and agency admin", () => {
  it("see every client", async () => {
    for (const u of [lead, admin]) {
      const scope = await visibleClients(u);
      expect(scope.all).toBe(true);
      expect(seesAllClients(scope.role)).toBe(true);
      expect(await visibleClientIds(u)).toHaveLength(totalClients);
    }
  });

  it("scope to an empty where, not an id list over the whole roster", async () => {
    expect(await clientScopeWhere(admin)).toEqual({});
    expect(await clientScopeWhere(lead)).toEqual({});
  });

  it("see all clients despite holding only one assignment", async () => {
    // Youssef Adel is assigned content_lead on CL-103 alone. That row makes him
    // the internal reviewer there; it does not narrow what he can see.
    const assignments = await prisma.clientAssignment.findMany({
      where: { user_id: lead.user_id },
    });
    expect(assignments).toHaveLength(1);
    expect(await canAccessClient(lead, "CL-101")).toBe(true);
  });
});

describe("account manager", () => {
  it("sees the clients they manage and no others", async () => {
    const scope = await visibleClients(accountManager);
    expect(scope.all).toBe(false);

    const managed = await prisma.client.findMany({
      where: { account_manager_id: accountManager.user_id },
      select: { client_id: true },
    });
    expect(scope.all === false && scope.clientIds.sort()).toEqual(
      managed.map((c) => c.client_id).sort(),
    );
    expect(managed.length).toBeGreaterThan(0);
    expect(managed.length).toBeLessThan(totalClients);
  });

  it("sees none of another account manager's clients", async () => {
    const mine = await visibleClientIds(accountManager);
    const theirs = await visibleClientIds(otherAccountManager);

    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);
    expect(mine.filter((id) => theirs.includes(id))).toEqual([]);

    expect(await canAccessClient(accountManager, theirs[0])).toBe(false);
    expect(await canAccessClient(otherAccountManager, mine[0])).toBe(false);
  });

  it("cannot see CL-109, which has no account manager", async () => {
    // The roster's real orphan. Nobody manages it, so no manager may reach it.
    const orphan = await prisma.client.findUniqueOrThrow({
      where: { client_id: "CL-109" },
    });
    expect(orphan.account_manager_id).toBeNull();

    for (const am of [accountManager, otherAccountManager]) {
      expect(await canAccessClient(am, "CL-109")).toBe(false);
    }
    // The admin still can -- oversight is the exception, and a deliberate one.
    expect(await canAccessClient(admin, "CL-109")).toBe(true);
  });
});

describe("content creator", () => {
  it("sees only the clients they are assigned to", async () => {
    const assigned = await prisma.clientAssignment.findMany({
      where: { user_id: creator.user_id },
      select: { client_id: true },
    });
    const expected = Array.from(new Set(assigned.map((a) => a.client_id))).sort();

    expect((await visibleClientIds(creator)).sort()).toEqual(expected);
    expect(expected.length).toBeGreaterThan(1); // several clients share a creator
    expect(expected.length).toBeLessThan(totalClients);
  });

  it("cannot reach a client they are not assigned to", async () => {
    const visible = await visibleClientIds(creator);
    const unassigned = await prisma.client.findFirstOrThrow({
      where: { client_id: { notIn: visible } },
      select: { client_id: true },
    });

    expect(await canAccessClient(creator, unassigned.client_id)).toBe(false);
  });
});

describe("client contact", () => {
  it("sees exactly one client — their own", async () => {
    const scope = await visibleClients(clientContact);

    expect(scope.all).toBe(false);
    expect(scope.all === false && scope.clientIds).toEqual(["CL-101"]);
  });

  it("cannot reach any other client", async () => {
    for (const other of ["CL-102", "CL-103", "CL-108", "CL-109"]) {
      expect(await canAccessClient(clientContact, other), other).toBe(false);
    }
  });

  it("is scoped by user_type even before any assignment exists", async () => {
    // A contact created by their account manager but not yet assigned must see
    // nothing -- not everything. This is the failure mode the module exists for.
    const fresh = await prisma.user.create({
      data: {
        name: "Test Scope Fresh Contact",
        email: "test-scope-fresh@skipstudio.test",
        user_type: "client_contact",
        status: "invited",
      },
      select: { user_id: true, user_type: true, is_agency_admin: true },
    });

    try {
      expect(await effectiveRole(fresh)).toBe("client_contact");
      expect(await visibleClientIds(fresh)).toEqual([]);
      expect(await canAccessClient(fresh, "CL-101")).toBe(false);

      // The critical one: an empty scope must filter everything out, never
      // collapse to "no filter" and hand over the whole roster.
      expect(await clientScopeWhere(fresh)).toEqual({ client_id: { in: [] } });
      expect(await prisma.client.count({ where: await clientScopeWhere(fresh) })).toBe(0);
    } finally {
      await prisma.user.delete({ where: { user_id: fresh.user_id } });
    }
  });
});

describe("clientScopeWhere", () => {
  it("filters a real query to exactly what the role may see", async () => {
    for (const u of [accountManager, creator, clientContact, lead, admin]) {
      const count = await prisma.client.count({ where: await clientScopeWhere(u) });
      expect(count).toBe((await visibleClientIds(u)).length);
    }
  });

  it("never lets a scoped role see the whole roster", async () => {
    for (const u of [accountManager, otherAccountManager, creator, clientContact]) {
      const count = await prisma.client.count({ where: await clientScopeWhere(u) });
      expect(count).toBeLessThan(totalClients);
    }
  });
});
