import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

import { prisma } from "../db";
import { creatorOverview, creatorQueue } from "./creatorQueue";

/**
 * What a creator has in front of them, and what they do not.
 *
 * The scoping rule this rests on is `accessScope`'s, tested there. What is
 * tested here is that this queue actually uses it -- a creator sees the clients
 * they hold a `ClientAssignment` on and no others -- plus the two judgements
 * this module makes on its own: which statuses are a creator's work, and which
 * of those are still theirs to change.
 */

/** Assigned to CL-101 and CL-102. */
const MONA = "mona.farid@skipstudio.test";
/** Assigned to CL-103 and CL-104 -- no overlap with Mona. */
const NOUR = "nour.kamal@skipstudio.test";

let mona: { user_id: string; user_type: string; is_agency_admin: boolean };
let nour: { user_id: string; user_type: string; is_agency_admin: boolean };

const campaignIds: string[] = [];
const itemIds: string[] = [];

async function creator(email: string) {
  return prisma.user.findUniqueOrThrow({
    where: { email },
    select: { user_id: true, user_type: true, is_agency_admin: true },
  });
}

async function createCampaign(clientId: string) {
  const campaign = await prisma.campaign.create({
    data: {
      client_id: clientId,
      title: "P7.1 creator queue",
      objective: "test the creator read layer",
      audience: "test",
      channels: JSON.stringify(["Instagram"]),
      raw_brief_text: "P7.1 test brief",
    },
  });
  campaignIds.push(campaign.campaign_id);
  return campaign.campaign_id;
}

async function createItem(
  campaignId: string,
  status: string,
  extra: { flagged_clause_id?: string } = {},
) {
  const item = await prisma.contentItem.create({
    data: {
      campaign_id: campaignId,
      content_form: "post",
      platform: "instagram",
      content_body: "Draft copy.",
      status,
      ...extra,
    },
  });
  itemIds.push(item.content_item_id);
  return item;
}

beforeAll(async () => {
  mona = await creator(MONA);
  nour = await creator(NOUR);
});

afterEach(async () => {
  await prisma.contentItem.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  await prisma.campaign.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  itemIds.length = 0;
  campaignIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("scope, via ClientAssignment", () => {
  it("shows a creator their assigned clients' work", async () => {
    const campaignId = await createCampaign("CL-101");
    const item = await createItem(campaignId, "drafted");

    const page = await creatorQueue(mona, { search: "P7.1 creator queue" });

    expect(page.rows.map((r) => r.content_item_id)).toContain(item.content_item_id);
  });

  it("never shows a creator a client they are not assigned to", async () => {
    const campaignId = await createCampaign("CL-103");
    const item = await createItem(campaignId, "drafted");

    // Nour holds CL-103; Mona does not. This is the whole of "just their
    // assigned clients' in-progress work".
    const hers = await creatorQueue(nour, { search: "P7.1 creator queue" });
    const theirs = await creatorQueue(mona, { search: "P7.1 creator queue" });

    expect(hers.rows.map((r) => r.content_item_id)).toContain(item.content_item_id);
    expect(theirs.rows.map((r) => r.content_item_id)).not.toContain(item.content_item_id);
  });

  it("narrowing by a client outside scope returns nothing, never widens", async () => {
    const campaignId = await createCampaign("CL-103");
    await createItem(campaignId, "drafted");

    const page = await creatorQueue(mona, { clientId: "CL-103" });

    expect(page.rows.every((r) => r.client_id !== "CL-103")).toBe(true);
  });
});

describe("which statuses are a creator's", () => {
  it("lists drafted, in_refinement and flagged work", async () => {
    const campaignId = await createCampaign("CL-101");
    const drafted = await createItem(campaignId, "drafted");
    const refining = await createItem(campaignId, "in_refinement");
    const flagged = await createItem(campaignId, "flagged");

    const page = await creatorQueue(mona, { search: "P7.1 creator queue" });
    const ids = page.rows.map((r) => r.content_item_id);

    expect(ids).toContain(drafted.content_item_id);
    expect(ids).toContain(refining.content_item_id);
    expect(ids).toContain(flagged.content_item_id);
  });

  it("keeps an item visible after it goes to the reviewer, but not editable", async () => {
    const campaignId = await createCampaign("CL-101");
    const submitted = await createItem(campaignId, "pending_internal_review");

    const page = await creatorQueue(mona, { search: "P7.1 creator queue" });
    const row = page.rows.find((r) => r.content_item_id === submitted.content_item_id);

    // Visible, so submitting does not look like work vanishing. Not editable,
    // because editing under a reviewer mid-decision would reset the item
    // beneath them.
    expect(row).toBeDefined();
    expect(row?.editable).toBe(false);
  });

  it("does not list published or approved work -- neither is a creator's to act on", async () => {
    const campaignId = await createCampaign("CL-101");
    const published = await createItem(campaignId, "published");
    const approved = await createItem(campaignId, "client_approved");

    const page = await creatorQueue(mona, { search: "P7.1 creator queue" });
    const ids = page.rows.map((r) => r.content_item_id);

    expect(ids).not.toContain(published.content_item_id);
    expect(ids).not.toContain(approved.content_item_id);
  });

  it("ignores a status outside the creator's set rather than honouring it", async () => {
    const campaignId = await createCampaign("CL-101");
    const published = await createItem(campaignId, "published");

    const page = await creatorQueue(mona, {
      status: "published",
      search: "P7.1 creator queue",
    });

    expect(page.rows.map((r) => r.content_item_id)).not.toContain(published.content_item_id);
  });
});

describe("what a flagged card carries", () => {
  it("carries the flagged clause's full text, not just its code", async () => {
    const clause = await prisma.guidelineClause.findFirstOrThrow({
      where: { source_type: "agency" },
      select: { clause_id: true, clause_code: true, text: true },
    });

    const campaignId = await createCampaign("CL-101");
    const item = await createItem(campaignId, "flagged", { flagged_clause_id: clause.clause_id });

    const page = await creatorQueue(mona, { flaggedOnly: true, search: "P7.1 creator queue" });
    const row = page.rows.find((r) => r.content_item_id === item.content_item_id);

    // The text, because a creator fixing a flagged draft has to know what the
    // rule says. Sending them elsewhere to look up "1.3" is how a flag gets
    // worked around rather than addressed.
    expect(row?.flagged_clause?.clause_code).toBe(clause.clause_code);
    expect(row?.flagged_clause?.text).toBe(clause.text);
  });

  it("flaggedOnly returns just the refused work", async () => {
    const campaignId = await createCampaign("CL-101");
    await createItem(campaignId, "drafted");
    await createItem(campaignId, "flagged");

    const page = await creatorQueue(mona, { flaggedOnly: true, search: "P7.1 creator queue" });

    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((r) => r.status === "flagged")).toBe(true);
  });
});

/**
 * The overview counts.
 *
 * The distinction worth pinning is between work stuck on this person and work
 * they have handed on. A panel that summed the two would tell a creator to act
 * on something that is a reviewer's move.
 */
describe("creatorOverview", () => {
  it("separates work stuck on the creator from work already handed on", async () => {
    const campaignId = await createCampaign("CL-101");
    await createItem(campaignId, "drafted");
    await createItem(campaignId, "in_refinement");
    await createItem(campaignId, "flagged");
    await createItem(campaignId, "pending_internal_review");

    const { counts } = await creatorOverview(mona);

    expect(counts.flagged).toBeGreaterThanOrEqual(1);
    expect(counts.inProgress).toBeGreaterThanOrEqual(2);
    // Submitted, and therefore a reviewer's move rather than the creator's.
    expect(counts.awaitingReview).toBeGreaterThanOrEqual(1);
  });

  it("counts as assigned only what was dispatched to this creator", async () => {
    const campaignId = await createCampaign("CL-101");
    const mine = await createItem(campaignId, "drafted");
    await createItem(campaignId, "drafted");

    await prisma.contentItem.update({
      where: { content_item_id: mine.content_item_id },
      data: { assigned_to_id: mona.user_id },
    });

    const before = await creatorOverview(mona);
    expect(before.counts.assigned).toBe(1);

    // Dispatched to someone else on the same client: in scope, but not theirs.
    await prisma.contentItem.update({
      where: { content_item_id: mine.content_item_id },
      data: { assigned_to_id: nour.user_id },
    });

    const after = await creatorOverview(mona);
    expect(after.counts.assigned).toBe(0);
  });

  it("never counts a client the creator is not assigned to", async () => {
    const campaignId = await createCampaign("CL-103");
    await createItem(campaignId, "flagged");

    const { clients } = await creatorOverview(mona);

    // Nour holds CL-103; Mona does not.
    expect(clients.map((c) => c.client_id)).not.toContain("CL-103");
  });

  it("breaks the counts down per client", async () => {
    const campaignId = await createCampaign("CL-101");
    await createItem(campaignId, "flagged");
    await createItem(campaignId, "drafted");

    const { clients } = await creatorOverview(mona);
    const row = clients.find((c) => c.client_id === "CL-101");

    expect(row).toBeDefined();
    expect(row!.flagged).toBeGreaterThanOrEqual(1);
    expect(row!.inProgress).toBeGreaterThanOrEqual(1);
  });
});
