import { describe, it, expect, beforeEach, afterAll } from "vitest";

import { prisma } from "@/db";
import { performanceFor, seriesFor } from "@/domain/analytics";

/**
 * `P10.4` — a second client's numbers never appear in either view.
 *
 * Asserted at the query layer rather than the UI, because that is where it has
 * to hold: a component that filtered correctly over a query that returned too
 * much would still be one refactor away from a leak, and the leak would be
 * invisible until someone screenshotted it.
 *
 * Both views call the same `performanceFor`, scoped by who is asking, so this
 * drives it as an account manager and as a client contact and checks the answer
 * against what each is actually entitled to.
 */

const MANAGED = "CL-101";
const OTHER = "CL-108";

const MANAGER = "TEST-AI-MANAGER";
const CONTACT = "TEST-AI-CONTACT";
const USERS = [MANAGER, CONTACT];

const campaignIds: string[] = [];

const manager = { user_id: MANAGER, user_type: "staff", is_agency_admin: false };
const contact = { user_id: CONTACT, user_type: "client_contact", is_agency_admin: false };

async function publishedItemWithMetrics(clientId: string, reach: number) {
  const campaign = await prisma.campaign.create({
    data: { client_id: clientId, title: `P10.4 ${clientId}`, raw_brief_text: "isolation test" },
  });
  campaignIds.push(campaign.campaign_id);

  const item = await prisma.contentItem.create({
    data: {
      campaign_id: campaign.campaign_id,
      content_form: "post",
      platform: "instagram",
      content_body: "Live.",
      status: "published",
    },
  });

  await prisma.metricSnapshot.createMany({
    data: [
      { content_item_id: item.content_item_id, metric_type: "reach", value: reach },
      { content_item_id: item.content_item_id, metric_type: "likes", value: reach / 10 },
    ],
  });

  return item.content_item_id;
}

async function cleanup() {
  if (campaignIds.length > 0) {
    const items = await prisma.contentItem.findMany({
      where: { campaign_id: { in: campaignIds } },
      select: { content_item_id: true },
    });
    const itemIds = items.map((i) => i.content_item_id);
    await prisma.metricSnapshot.deleteMany({ where: { content_item_id: { in: itemIds } } });
    await prisma.contentItem.deleteMany({ where: { campaign_id: { in: campaignIds } } });
    await prisma.campaign.deleteMany({ where: { campaign_id: { in: campaignIds } } });
    campaignIds.length = 0;
  }
  await prisma.clientAssignment.deleteMany({ where: { user_id: { in: USERS } } });
}

beforeEach(async () => {
  await cleanup();

  for (const id of USERS) {
    await prisma.user.upsert({
      where: { user_id: id },
      update: { status: "active" },
      create: {
        user_id: id,
        name: id,
        email: `${id.toLowerCase()}@skipstudio.test`,
        user_type: id === CONTACT ? "client_contact" : "staff",
      },
    });
  }

  // The manager holds CL-101 and not CL-108.
  await prisma.client.update({
    where: { client_id: MANAGED },
    data: { account_manager_id: MANAGER },
  });

  await prisma.clientAssignment.create({
    data: { client_id: MANAGED, user_id: CONTACT, role_on_client: "client_approver" },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { user_id: { in: USERS } } });
});

describe("analytics scope", () => {
  it("keeps another client's numbers out of an account manager's view", async () => {
    await publishedItemWithMetrics(MANAGED, 1_000);
    const foreign = await publishedItemWithMetrics(OTHER, 9_999);

    const performance = await performanceFor(manager);

    const clientIds = new Set(performance.items.map((item) => item.client_id));
    expect(clientIds.has(MANAGED)).toBe(true);
    expect(clientIds.has(OTHER)).toBe(false);

    // The totals are the giveaway a row filter would miss: a query returning
    // both clients and rendering one would still sum both.
    expect(performance.totals.reach).toBe(1_000);
    expect(performance.items.map((i) => i.content_item_id)).not.toContain(foreign);
  });

  it("shows a client contact only their own client", async () => {
    await publishedItemWithMetrics(MANAGED, 500);
    await publishedItemWithMetrics(OTHER, 9_999);

    const performance = await performanceFor(contact);

    const clientIds = new Set(performance.items.map((item) => item.client_id));
    expect([...clientIds]).toEqual([MANAGED]);
    expect(performance.totals.reach).toBe(500);
  });

  it("returns no series for an item outside the caller's scope", async () => {
    const foreign = await publishedItemWithMetrics(OTHER, 9_999);

    // Empty rather than an error: a caller must not learn from the difference
    // that another client's post exists.
    expect(await seriesFor(manager, foreign)).toEqual([]);
    expect(await seriesFor(contact, foreign)).toEqual([]);
  });

  it("returns the series for an item inside scope", async () => {
    const mine = await publishedItemWithMetrics(MANAGED, 400);

    const series = await seriesFor(manager, mine);
    expect(series.length).toBeGreaterThan(0);
  });
});
