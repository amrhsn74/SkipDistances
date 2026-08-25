import { describe, it, expect, beforeAll, afterEach } from "vitest";

import { prisma } from "../db";
import type { ScopeUser } from "./accessScope";
import {
  ClientValidationError,
  createClient,
  getClient,
  listClients,
} from "./clientRoster";

/**
 * Driven against the seeded roster rather than fixtures. CL-101 is NileFit
 * (active, Egypt), CL-103 is MedCare Clinics (healthcare, so sensitive), and
 * CL-109 is a real inactive client with no account manager. Real data cannot
 * drift from itself.
 *
 * The scoping assertions matter most. A roster endpoint that returns the right
 * rows for the right person but one extra row for the wrong one is the exact
 * failure the isolation guarantee exists to prevent.
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
let contact: ScopeUser;
let accountManager: ScopeUser;

let egyptId = "";
let saudiId = "";

/** Clients this file created, cleaned up by id so a failure cannot leak rows. */
const created: string[] = [];

beforeAll(async () => {
  admin = await userByEmail("hala.mansour@skipstudio.test");
  lead = await userByEmail("youssef.adel@skipstudio.test");
  creator = await userByEmail("mona.farid@skipstudio.test");
  contact = await userByEmail("rana.fouad@skipstudio.test");

  const managed = await prisma.client.findFirstOrThrow({
    where: { NOT: { account_manager_id: null } },
    select: { account_manager_id: true },
    orderBy: { client_id: "asc" },
  });
  accountManager = await prisma.user.findUniqueOrThrow({
    where: { user_id: managed.account_manager_id! },
    select: { user_id: true, user_type: true, is_agency_admin: true },
  });

  egyptId = (await prisma.market.findFirstOrThrow({ where: { country_code: "EG" } })).market_id;
  saudiId = (await prisma.market.findFirstOrThrow({ where: { country_code: "SA" } })).market_id;
});

/**
 * Every client this file creates uses one of these names, and cleanup keys on
 * the name as well as on the captured ids -- a test asserting that a create is
 * *refused* has no id to record, so a broken guard would otherwise leave a row
 * behind and desync the seeded roster that other test files count on.
 */
const TEST_CLIENT_NAMES = [
  "Test Roastery",
  "Id Probe",
  "Test Clinic",
  "Test Cafe",
  "Audited Co",
  "Marketless",
  "Fake Market",
  "Bad Status",
  "Contact As Manager",
  "Duplicate",
  "Scope Probe",
];

afterEach(async () => {
  const strays = await prisma.client.findMany({
    where: { name: { in: TEST_CLIENT_NAMES } },
    select: { client_id: true },
  });

  const ids = new Set([...created, ...strays.map((s) => s.client_id)]);
  created.length = 0;

  for (const id of ids) {
    await prisma.auditLog.deleteMany({ where: { entity_type: "Client", entity_id: id } });
    await prisma.client.deleteMany({ where: { client_id: id } });
  }
});

async function create(input: Parameters<typeof createClient>[0], byId: string) {
  const client = await createClient(input, byId);
  created.push(client.client_id);
  return client;
}

describe("listClients — scope", () => {
  it("gives the agency admin and the content lead the whole roster", async () => {
    const total = await prisma.client.count();

    expect((await listClients(admin)).length).toBe(total);
    expect((await listClients(lead)).length).toBe(total);
  });

  it("gives an account manager only the clients they manage", async () => {
    const rows = await listClients(accountManager);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.account_manager_id).toBe(accountManager.user_id);
    }

    const total = await prisma.client.count();
    expect(rows.length).toBeLessThan(total);
  });

  it("gives a content creator only their assigned clients", async () => {
    const assigned = await prisma.clientAssignment.findMany({
      where: { user_id: creator.user_id },
      select: { client_id: true },
    });
    const expected = new Set(assigned.map((a) => a.client_id));

    const rows = await listClients(creator);

    expect(rows.length).toBe(expected.size);
    for (const row of rows) expect(expected.has(row.client_id)).toBe(true);
  });

  it("gives a client contact exactly their own client", async () => {
    const rows = await listClients(contact);

    expect(rows).toHaveLength(1);
    expect(rows[0].client_id).toBe("CL-101");
  });

  it("never returns another manager's client to an account manager", async () => {
    const mine = new Set((await listClients(accountManager)).map((r) => r.client_id));

    const theirs = await prisma.client.findMany({
      where: {
        NOT: [{ account_manager_id: accountManager.user_id }, { account_manager_id: null }],
      },
      select: { client_id: true },
    });

    expect(theirs.length).toBeGreaterThan(0);
    for (const row of theirs) expect(mine.has(row.client_id)).toBe(false);
  });
});

describe("listClients — shape", () => {
  it("decodes channels and resolves the markets each client operates in", async () => {
    const nileFit = (await listClients(admin)).find((c) => c.client_id === "CL-101")!;

    expect(nileFit.name).toBe("NileFit");
    expect(nileFit.channels).toContain("instagram");
    expect(nileFit.markets.length).toBeGreaterThan(0);
    expect(nileFit.markets.map((m) => m.country_code)).toContain("EG");
  });

  it("carries the roster's nullable fields as null rather than dropping them", async () => {
    // CL-109 is a former client: no account manager, no brand guide.
    const former = await getClient(admin, "CL-109");

    expect(former).not.toBeNull();
    expect(former!.account_manager_id).toBeNull();
    expect(former!.account_manager_name).toBeNull();
    expect(former!.active_brand_guide_id).toBeNull();
  });
});

describe("getClient", () => {
  it("returns null for a client outside the caller's scope, not the row", async () => {
    // The contact is CL-101's approver; CL-102 is a real client they may not see.
    expect(await getClient(contact, "CL-102")).toBeNull();
    expect(await getClient(admin, "CL-102")).not.toBeNull();
  });

  it("returns null for an unknown client", async () => {
    expect(await getClient(admin, "CL-999999")).toBeNull();
  });
});

describe("createClient", () => {
  it("creates a client with its markets and allocates the next CL- id", async () => {
    const before = await prisma.client.count();

    const client = await create(
      {
        name: "Test Roastery",
        industry: "food & beverage",
        marketIds: [egyptId, saudiId],
        channels: ["instagram"],
      },
      accountManager.user_id,
    );

    expect(client.client_id).toMatch(/^CL-\d+$/);
    expect(await prisma.client.count()).toBe(before + 1);
    expect(client.markets.map((m) => m.country_code).sort()).toEqual(["EG", "SA"]);
    expect(client.channels).toEqual(["instagram"]);
    // Defaults to the creator: an unowned client has no internal reviewer.
    expect(client.account_manager_id).toBe(accountManager.user_id);
  });

  it("allocates an id above every existing one rather than from a count", async () => {
    const existing = await prisma.client.findMany({ select: { client_id: true } });
    const highest = Math.max(
      ...existing.map((c) => Number(/^CL-(\d+)$/.exec(c.client_id)?.[1] ?? 0)),
    );

    const client = await create(
      { name: "Id Probe", industry: "retail", marketIds: [egyptId] },
      accountManager.user_id,
    );

    expect(Number(/^CL-(\d+)$/.exec(client.client_id)![1])).toBe(highest + 1);
  });

  it("derives sensitive_sector from the industry, never from the caller", async () => {
    const clinic = await create(
      {
        name: "Test Clinic",
        industry: "healthcare",
        marketIds: [egyptId],
        // A caller cannot pass this at all -- the type has no such field, and
        // this asserts the derivation actually runs rather than defaulting.
      },
      accountManager.user_id,
    );
    expect(clinic.sensitive_sector).toBe(true);

    const cafe = await create(
      { name: "Test Cafe", industry: "food & beverage", marketIds: [egyptId] },
      accountManager.user_id,
    );
    expect(cafe.sensitive_sector).toBe(false);
  });

  it("writes an audit row naming who created the client", async () => {
    const client = await create(
      { name: "Audited Co", industry: "retail", marketIds: [egyptId] },
      accountManager.user_id,
    );

    const rows = await prisma.auditLog.findMany({
      where: { entity_type: "Client", entity_id: client.client_id },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("created");
    expect(rows[0].performed_by_id).toBe(accountManager.user_id);
  });

  it("refuses a client with no market", async () => {
    await expect(
      createClient(
        { name: "Marketless", industry: "retail", marketIds: [] },
        accountManager.user_id,
      ),
    ).rejects.toBeInstanceOf(ClientValidationError);
  });

  it("refuses a market id the caller invented, and writes nothing", async () => {
    const before = await prisma.client.count();

    await expect(
      createClient(
        { name: "Fake Market", industry: "retail", marketIds: ["mkt-does-not-exist"] },
        accountManager.user_id,
      ),
    ).rejects.toBeInstanceOf(ClientValidationError);

    expect(await prisma.client.count()).toBe(before);
  });

  it("refuses a missing name or industry, naming the field", async () => {
    let error: unknown;
    try {
      await createClient(
        { name: "  ", industry: "", marketIds: [egyptId] },
        accountManager.user_id,
      );
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ClientValidationError);
    expect(Object.keys((error as ClientValidationError).issues).sort()).toEqual([
      "industry",
      "name",
    ]);
  });

  it("refuses a status outside active/inactive", async () => {
    await expect(
      createClient(
        { name: "Bad Status", industry: "retail", marketIds: [egyptId], status: "archived" },
        accountManager.user_id,
      ),
    ).rejects.toBeInstanceOf(ClientValidationError);
  });

  it("refuses a client contact as the account manager", async () => {
    await expect(
      createClient(
        {
          name: "Contact As Manager",
          industry: "retail",
          marketIds: [egyptId],
          accountManagerId: contact.user_id,
        },
        accountManager.user_id,
      ),
    ).rejects.toBeInstanceOf(ClientValidationError);
  });

  it("rolls the market rows back when the client write fails", async () => {
    // A duplicate id fails after the markets are staged in the same statement.
    await expect(
      createClient(
        { name: "Duplicate", industry: "retail", marketIds: [egyptId], clientId: "CL-101" },
        accountManager.user_id,
      ),
    ).rejects.toThrow();

    // CL-101's own market rows are untouched -- the failed write added none.
    const markets = await prisma.clientMarket.count({ where: { client_id: "CL-101" } });
    expect(markets).toBe(1);
  });

  it("is immediately visible to the manager who created it, and to nobody else", async () => {
    const client = await create(
      { name: "Scope Probe", industry: "retail", marketIds: [egyptId] },
      accountManager.user_id,
    );

    const mine = (await listClients(accountManager)).map((c) => c.client_id);
    expect(mine).toContain(client.client_id);

    const theirs = (await listClients(contact)).map((c) => c.client_id);
    expect(theirs).not.toContain(client.client_id);
  });
});
