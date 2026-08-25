import { describe, it, expect, afterEach, vi } from "vitest";

import { prisma } from "@/db";
import { SESSION_COOKIE } from "@/api/request";
import { createSession } from "@/domain/session";
import { operationalSummary, type ClientSummary } from "@/domain/summary";

/**
 * The counts panel.
 *
 * Two claims are worth testing here, and they pull in opposite directions.
 *
 * The first is that the numbers are right: an item at `pending_client_review`
 * lands in that bucket and in `awaiting.client_review`, a market-tagged item is
 * counted under its market while an evergreen one is counted as neutral, and the
 * totals are the sum of the per-client rows rather than a separately computed
 * number that could drift from them.
 *
 * The second is that the panel is scoped. It is the one endpoint whose whole
 * purpose is to aggregate across clients, which makes it the most natural place
 * for a cross-client leak to hide -- a rollup that quietly counted a client the
 * caller cannot see would still look like a plausible number. So an account
 * manager's summary is asserted to contain their clients and none of another
 * manager's, and a client contact's is asserted to be exactly one client.
 *
 * That is the counterpart, at the query layer, to `P11.6`. The scope is passed
 * into `operationalSummary` as a parameter, so this drives the same function the
 * Admin's unscoped view will.
 *
 * Nothing is mocked but the cookie jar.
 */

let cookieJar: Record<string, string> = {};

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      cookieJar[name] === undefined ? undefined : { name, value: cookieJar[name] },
  }),
}));

// Imported after the mock is registered, so the route picks it up.
const { GET } = await import("@/app/api/summary/route");

/** Manages CL-101 and CL-105, among others. */
const AM_EMAIL = "sara.selim@skipstudio.test";
/** Manages CL-102 and CL-108 -- disjoint from the above. */
const OTHER_AM_EMAIL = "omar.zaki@skipstudio.test";
/** CL-101's client contact -- sees exactly one client. */
const CONTACT_EMAIL = "rana.fouad@skipstudio.test";
/** The content lead -- one of the two cross-client roles. A single
 *  `content_lead` assignment grants the all-clients role, by design. */
const LEAD_EMAIL = "youssef.adel@skipstudio.test";

const campaignIds: string[] = [];
const itemIds: string[] = [];
const sessionUserIds: string[] = [];

async function signIn(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const { token } = await createSession({ userId: user.user_id });
  cookieJar[SESSION_COOKIE] = token;
  sessionUserIds.push(user.user_id);
  return user;
}

async function fetchSummary(query = "") {
  const response = await GET(new Request(`http://localhost/api/summary${query}`));
  return { response, body: await response.json() };
}

/** A campaign on a client, with items at the given statuses. */
async function seedItems(
  clientId: string,
  items: { status: string; marketId?: string | null }[],
) {
  const campaign = await prisma.campaign.create({
    data: {
      client_id: clientId,
      title: "P4.8 summary test",
      objective: "test the counts panel",
      audience: "test",
      channels: JSON.stringify(["Instagram"]),
      raw_brief_text: "P4.8 test brief",
    },
  });
  campaignIds.push(campaign.campaign_id);

  for (const item of items) {
    const row = await prisma.contentItem.create({
      data: {
        campaign_id: campaign.campaign_id,
        content_form: "post",
        platform: "instagram",
        content_body: "Copy.",
        status: item.status,
        market_id: item.marketId ?? null,
      },
    });
    itemIds.push(row.content_item_id);
  }

  return campaign.campaign_id;
}

/**
 * One client's row out of a JSON response body.
 *
 * Typed as `ClientSummary` rather than a narrow inline shape: the body has been
 * through `JSON.parse`, so it is `any` at the boundary, and asserting the
 * domain type here is what makes a field renamed in `summary.ts` fail this file
 * rather than silently reading `undefined`.
 */
function clientRow(body: { clients: ClientSummary[] }, clientId: string) {
  return body.clients.find((c) => c.client_id === clientId);
}

async function marketIds() {
  const markets = await prisma.market.findMany({ orderBy: { country_code: "asc" } });
  const egypt = markets.find((m) => m.country_code === "EG");
  const saudi = markets.find((m) => m.country_code === "SA");
  return { egypt: egypt!.market_id, saudi: saudi!.market_id };
}

afterEach(async () => {
  cookieJar = {};

  await prisma.contentItem.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.campaign.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  await prisma.auditLog.deleteMany({ where: { entity_id: { in: campaignIds } } });

  while (sessionUserIds.length > 0) {
    await prisma.session.deleteMany({ where: { user_id: sessionUserIds.pop()! } });
  }
  itemIds.length = 0;
  campaignIds.length = 0;
});

// ---------------------------------------------------------------------------
// The counts
// ---------------------------------------------------------------------------

describe("GET /api/summary", () => {
  it("refuses an unauthenticated request with 401", async () => {
    const { response } = await fetchSummary();

    expect(response.status).toBe(401);
  });

  it("counts items by status, with every status present", async () => {
    await seedItems("CL-101", [
      { status: "drafted" },
      { status: "drafted" },
      { status: "pending_client_review" },
      { status: "published" },
    ]);

    await signIn(AM_EMAIL);
    const { body } = await fetchSummary();

    const row = clientRow(body, "CL-101")!;
    expect(row.by_status.drafted).toBe(2);
    expect(row.by_status.pending_client_review).toBe(1);
    expect(row.by_status.published).toBe(1);
    // Present-with-zero, so a panel renders a stable set of rows.
    expect(row.by_status.publish_failed).toBe(0);
    expect(row.by_status.scheduled).toBe(0);
    expect(row.total_items).toBe(4);
  });

  it("surfaces what needs a human, separately from the raw counts", async () => {
    await seedItems("CL-101", [
      { status: "pending_internal_review" },
      { status: "pending_client_review" },
      { status: "pending_client_review" },
      { status: "flagged" },
      { status: "publish_failed" },
      // History, not a queue.
      { status: "published" },
      { status: "published" },
    ]);

    await signIn(AM_EMAIL);
    const { body } = await fetchSummary();

    const row = clientRow(body, "CL-101")!;
    expect(row.awaiting).toEqual({
      internal_review: 1,
      client_review: 2,
      flagged: 1,
      publish_failed: 1,
    });
  });

  it("counts market-tagged items per market and evergreen ones as neutral", async () => {
    const { egypt, saudi } = await marketIds();

    await seedItems("CL-101", [
      { status: "drafted", marketId: egypt },
      { status: "drafted", marketId: egypt },
      { status: "drafted", marketId: saudi },
      // Evergreen or shared-occasion -- produced once, no market.
      { status: "drafted", marketId: null },
    ]);

    await signIn(AM_EMAIL);
    const { body } = await fetchSummary();

    const row = clientRow(body, "CL-101")!;
    expect(row.by_market[egypt]).toBe(2);
    expect(row.by_market[saudi]).toBe(1);
    expect(row.market_neutral).toBe(1);
    // The three groupings describe the same four items.
    expect(row.by_market[egypt] + row.by_market[saudi] + row.market_neutral).toBe(row.total_items);
  });

  it("lists the markets each client operates in", async () => {
    await signIn(AM_EMAIL);
    const { body } = await fetchSummary();

    const row = clientRow(body, "CL-101")!;
    expect(row.markets.length).toBeGreaterThan(0);
    expect(row.markets[0]).toHaveProperty("country_code");
  });

  it("rolls totals up from the per-client rows rather than recomputing", async () => {
    await seedItems("CL-101", [{ status: "drafted" }, { status: "flagged" }]);
    await seedItems("CL-105", [{ status: "drafted" }]);

    await signIn(AM_EMAIL);
    const { body } = await fetchSummary();

    const summed = body.clients.reduce(
      (n: number, c: { total_items: number }) => n + c.total_items,
      0,
    );
    expect(body.totals.items).toBe(summed);
    expect(body.totals.clients).toBe(body.clients.length);
    expect(body.totals.by_status.drafted).toBe(2);
    expect(body.totals.awaiting.flagged).toBe(1);
  });

  it("includes upcoming occasions for the markets in scope", async () => {
    await signIn(AM_EMAIL);
    const { body } = await fetchSummary("?window_days=365");

    expect(Array.isArray(body.upcoming_occasions)).toBe(true);
    expect(body.upcoming_occasions.length).toBeGreaterThan(0);
    // Each carries per-market dates, which is what lets a dual-market client
    // schedule the same observance on two different days.
    expect(body.upcoming_occasions[0]).toHaveProperty("dates");
    expect(body.window.from).toBeTruthy();
  });

  it("clamps an absurd window rather than erroring", async () => {
    await signIn(AM_EMAIL);

    const { response } = await fetchSummary("?window_days=999999");
    expect(response.status).toBe(200);

    const negative = await fetchSummary("?window_days=-5");
    expect(negative.response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Scope -- the reason this endpoint is the easiest place for a leak to hide
// ---------------------------------------------------------------------------

describe("summary scope", () => {
  it("gives an account manager their clients and none of another's", async () => {
    await seedItems("CL-101", [{ status: "drafted" }]);
    await seedItems("CL-102", [{ status: "drafted" }]);

    await signIn(AM_EMAIL);
    const { body } = await fetchSummary();

    const ids = body.clients.map((c: { client_id: string }) => c.client_id);
    expect(ids).toContain("CL-101");
    expect(ids).toContain("CL-105");
    // CL-102 and CL-108 belong to the other account manager.
    expect(ids).not.toContain("CL-102");
    expect(ids).not.toContain("CL-108");
    expect(body.scope.all_clients).toBe(false);
  });

  it("gives the other account manager the complementary view", async () => {
    await signIn(OTHER_AM_EMAIL);
    const { body } = await fetchSummary();

    const ids = body.clients.map((c: { client_id: string }) => c.client_id);
    expect(ids).toContain("CL-102");
    expect(ids).not.toContain("CL-101");
  });

  it("gives a client contact exactly their own client", async () => {
    await seedItems("CL-101", [{ status: "drafted" }]);
    await seedItems("CL-102", [{ status: "drafted" }]);

    await signIn(CONTACT_EMAIL);
    const { body } = await fetchSummary();

    expect(body.clients.map((c: { client_id: string }) => c.client_id)).toEqual(["CL-101"]);
    expect(body.totals.clients).toBe(1);
  });

  it("gives the content lead every client -- one of the two deliberate exceptions", async () => {
    await signIn(LEAD_EMAIL);
    const { body } = await fetchSummary();

    expect(body.scope.all_clients).toBe(true);
    // The seeded roster is 150 clients.
    expect(body.clients.length).toBe(150);
  });

  it("never counts an out-of-scope client's items in the totals", async () => {
    // Six items on a client this manager cannot see, one on a client they can.
    await seedItems("CL-102", [
      { status: "drafted" },
      { status: "drafted" },
      { status: "flagged" },
      { status: "flagged" },
      { status: "published" },
      { status: "published" },
    ]);
    await seedItems("CL-101", [{ status: "drafted" }]);

    await signIn(AM_EMAIL);
    const { body } = await fetchSummary();

    // The leak this would show is a plausible-looking number, not an error --
    // which is exactly why it is asserted rather than eyeballed.
    expect(body.totals.by_status.flagged).toBe(0);
    expect(body.totals.by_status.published).toBe(0);
    expect(body.totals.by_status.drafted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The domain function, driven directly -- the shape P11.5 reuses
// ---------------------------------------------------------------------------

describe("operationalSummary", () => {
  it("takes scope as a parameter, so the Admin's view is the same query unscoped", async () => {
    await seedItems("CL-101", [{ status: "drafted" }]);

    const scoped = await operationalSummary(["CL-101"]);
    expect(scoped.clients.map((c) => c.client_id)).toEqual(["CL-101"]);

    const unscoped = await operationalSummary("all");
    expect(unscoped.clients.length).toBe(150);
    expect(unscoped.totals.clients).toBe(150);
  });

  it("returns an empty panel for a scope with no clients, rather than throwing", async () => {
    const summary = await operationalSummary([]);

    expect(summary.clients).toEqual([]);
    expect(summary.totals.items).toBe(0);
    expect(summary.upcoming_occasions).toEqual([]);
    // Every status still present at zero, so a panel renders the same rows.
    expect(summary.totals.by_status.drafted).toBe(0);
  });

  it("counts a client with no campaigns at zero rather than omitting it", async () => {
    // Nothing is seeded for CL-116 and this test creates nothing for it. A
    // client with nothing in flight is still an account that has to appear in
    // the panel -- omitting it would make an idle account invisible, which is
    // the opposite of what a "where does everything stand" view is for.
    const summary = await operationalSummary(["CL-116"]);

    expect(summary.clients).toHaveLength(1);
    expect(summary.clients[0].total_items).toBe(0);
    expect(summary.clients[0].campaign_count).toBe(0);
  });
});
