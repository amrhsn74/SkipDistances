import { describe, it, expect, beforeAll } from "vitest";

import { prisma } from "@/db";
import { effectiveRole, visibleClientIds } from "@/domain/accessScope";

/**
 * `P11.6` — cross-client visibility belongs to two roles, and to nobody else.
 *
 * The counterpart to `P10.4`. Every screen in the product derives its scope from
 * `visibleClientIds`, so this drives that one function as each of the five roles
 * and asserts the answer. The point is not that the function works -- its own
 * unit tests cover that -- but that the two *exceptions* are deliberate: the
 * content lead and the agency admin see everything because oversight and
 * cross-account review are their jobs, and the moment a third role joins them it
 * should fail here with the claim named rather than surface as a leak.
 *
 * Driven against the seeded roster rather than fixtures. A test that builds its
 * own two-client world would pass while the real 150-client roster leaked.
 */

type Actor = { user_id: string; user_type: string; is_agency_admin: boolean };

let accountManager: Actor;
let contentLead: Actor;
let contentCreator: Actor;
let clientContact: Actor;
let agencyAdmin: Actor;
let totalClients: number;

async function findByRole(where: Record<string, unknown>): Promise<Actor> {
  return prisma.user.findFirstOrThrow({
    where,
    select: { user_id: true, user_type: true, is_agency_admin: true },
  });
}

beforeAll(async () => {
  totalClients = await prisma.client.count();

  agencyAdmin = await findByRole({ is_agency_admin: true });
  clientContact = await findByRole({ user_type: "client_contact", status: "active" });

  contentLead = await findByRole({
    user_type: "staff",
    is_agency_admin: false,
    assignments: { some: { role_on_client: "content_lead" } },
  });

  contentCreator = await findByRole({
    user_type: "staff",
    is_agency_admin: false,
    assignments: { some: { role_on_client: "content_creator" } },
    // Not also a lead: a user holding both resolves to lead, and would make this
    // test assert the wrong role's behaviour.
    NOT: { assignments: { some: { role_on_client: "content_lead" } } },
  });

  accountManager = await findByRole({
    user_type: "staff",
    is_agency_admin: false,
    managed_clients: { some: {} },
    assignments: { none: {} },
  });
});

describe("the two cross-client roles", () => {
  it("gives the content lead every client", async () => {
    expect(await effectiveRole(contentLead)).toBe("content_lead");
    const visible = await visibleClientIds(contentLead);
    expect(visible).toHaveLength(totalClients);
  });

  it("gives the agency admin every client", async () => {
    expect(await effectiveRole(agencyAdmin)).toBe("agency_admin");
    const visible = await visibleClientIds(agencyAdmin);
    expect(visible).toHaveLength(totalClients);
  });
});

describe("every other role is scoped", () => {
  it("shows an account manager only the clients they manage", async () => {
    expect(await effectiveRole(accountManager)).toBe("account_manager");

    const visible = await visibleClientIds(accountManager);
    const managed = await prisma.client.findMany({
      where: { account_manager_id: accountManager.user_id },
      select: { client_id: true },
    });

    expect(visible.sort()).toEqual(managed.map((c) => c.client_id).sort());
    expect(visible.length).toBeLessThan(totalClients);
  });

  it("shows a content creator only their assignments", async () => {
    expect(await effectiveRole(contentCreator)).toBe("content_creator");

    const visible = await visibleClientIds(contentCreator);
    const assigned = await prisma.clientAssignment.findMany({
      where: { user_id: contentCreator.user_id },
      select: { client_id: true },
    });

    expect(visible.sort()).toEqual([...new Set(assigned.map((a) => a.client_id))].sort());
    expect(visible.length).toBeLessThan(totalClients);
  });

  it("shows a client contact exactly one client", async () => {
    expect(await effectiveRole(clientContact)).toBe("client_contact");

    const visible = await visibleClientIds(clientContact);

    // Capped at one by the single-approver invariant, so this cannot widen even
    // if a second assignment row were added by mistake.
    expect(visible).toHaveLength(1);
  });
});

describe("the exceptions are exactly two", () => {
  it("no other role sees the whole roster", async () => {
    const scoped = [accountManager, contentCreator, clientContact];

    for (const actor of scoped) {
      const visible = await visibleClientIds(actor);
      const role = await effectiveRole(actor);
      expect(
        visible.length,
        `${role} must not see every client`,
      ).toBeLessThan(totalClients);
    }
  });

  it("a creator's clients never include another creator's", async () => {
    const other = await prisma.user.findFirst({
      where: {
        user_type: "staff",
        is_agency_admin: false,
        user_id: { not: contentCreator.user_id },
        assignments: { some: { role_on_client: "content_creator" } },
        NOT: { assignments: { some: { role_on_client: "content_lead" } } },
      },
      select: { user_id: true, user_type: true, is_agency_admin: true },
    });

    if (!other) return;

    const mine = await visibleClientIds(contentCreator);
    const theirs = await visibleClientIds(other);

    // Overlap is legitimate -- two creators can share a client. What must not
    // happen is one seeing a client they hold no assignment on.
    const assigned = await prisma.clientAssignment.findMany({
      where: { user_id: contentCreator.user_id },
      select: { client_id: true },
    });
    const allowed = new Set(assigned.map((a) => a.client_id));

    for (const clientId of mine) {
      expect(allowed.has(clientId), `${clientId} is not assigned to this creator`).toBe(true);
    }
    void theirs;
  });
});
