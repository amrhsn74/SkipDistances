import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { prisma } from "../db";
import { reviewItem, reviewQueue, serializeReviewItem } from "./reviewQueue";

/**
 * What each stage's reviewer is shown.
 *
 * The gate's most-recent-per-stage reading is `gate.test.ts`'s and the
 * transition table is `statusMachine.test.ts`'s. What is tested here is what
 * this read layer adds on top of them: that a stage sees its own statuses and
 * not the other's, that scope narrows the list rather than a parameter, that a
 * status filter can only narrow within the stage's set, and that the decisions
 * shown on a card are the same rows the gate would read.
 *
 * The database is real -- there is no LLM on this path, so mocking would only
 * hide the query being wrong.
 */

const CLIENT_ID = "CL-101";
/** A second client on a different account manager, for the isolation cases. */
const OTHER_CLIENT_ID = "CL-103";

let campaignId = "";
let otherCampaignId = "";
let reviewerId = "";
let contactId = "";

/** The account manager who manages CL-101 -- its internal reviewer by default. */
let reviewer: { user_id: string; user_type: string; is_agency_admin: boolean };
/** CL-101's client contact. */
let contact: { user_id: string; user_type: string; is_agency_admin: boolean };

const itemIds: string[] = [];

/** An item on CL-101 at a given status. */
async function createItem(
  status: string,
  extra: { campaign?: string; body?: string; scheduled_date?: Date } = {},
) {
  const item = await prisma.contentItem.create({
    data: {
      campaign_id: extra.campaign ?? campaignId,
      content_form: "post",
      platform: "instagram",
      content_body: extra.body ?? "Draft copy.",
      status,
      ...(extra.scheduled_date ? { scheduled_date: extra.scheduled_date } : {}),
    },
  });
  itemIds.push(item.content_item_id);
  return item;
}

async function decide(
  contentItemId: string,
  stage: "internal" | "client",
  decision: "approve" | "decline",
  by: string,
) {
  return prisma.approval.create({
    data: {
      content_item_id: contentItemId,
      stage,
      decision,
      comment: decision === "decline" ? "needs work" : null,
      decided_by_id: by,
    },
  });
}

beforeAll(async () => {
  const am = await prisma.client.findUniqueOrThrow({
    where: { client_id: CLIENT_ID },
    select: { account_manager_id: true },
  });
  reviewerId = am.account_manager_id!;

  reviewer = await prisma.user.findUniqueOrThrow({
    where: { user_id: reviewerId },
    select: { user_id: true, user_type: true, is_agency_admin: true },
  });

  const assignment = await prisma.clientAssignment.findFirstOrThrow({
    where: { client_id: CLIENT_ID, role_on_client: "client_approver" },
    select: { user_id: true },
  });
  contactId = assignment.user_id;

  contact = await prisma.user.findUniqueOrThrow({
    where: { user_id: contactId },
    select: { user_id: true, user_type: true, is_agency_admin: true },
  });

  const campaign = await prisma.campaign.create({
    data: {
      client_id: CLIENT_ID,
      title: "P6.1 review queue",
      objective: "test the review read layer",
      audience: "test",
      channels: JSON.stringify(["Instagram"]),
      raw_brief_text: "P6.1 test brief",
    },
  });
  campaignId = campaign.campaign_id;

  const other = await prisma.campaign.create({
    data: {
      client_id: OTHER_CLIENT_ID,
      title: "P6.1 someone else's brief",
      objective: "must never appear in CL-101's queue",
      audience: "test",
      channels: JSON.stringify(["Instagram"]),
      raw_brief_text: "P6.1 other client",
    },
  });
  otherCampaignId = other.campaign_id;
});

afterAll(async () => {
  await prisma.comment.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.approval.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.contentItem.deleteMany({
    where: { campaign_id: { in: [campaignId, otherCampaignId] } },
  });
  await prisma.campaign.deleteMany({
    where: { campaign_id: { in: [campaignId, otherCampaignId] } },
  });
  await prisma.$disconnect();
});

describe("which statuses each stage sees", () => {
  it("shows the internal stage what is waiting on it, and what it has approved", async () => {
    const pending = await createItem("pending_internal_review");
    const approved = await createItem("internal_approved");

    const page = await reviewQueue(reviewer, "internal", { search: "P6.1 review queue" });
    const ids = page.rows.map((r) => r.content_item_id);

    expect(ids).toContain(pending.content_item_id);
    // An approved item stays listed: the late-revoke this phase builds is
    // meaningless if the only route back to it is a URL nobody kept.
    expect(ids).toContain(approved.content_item_id);
  });

  it("never shows the internal stage an item at the client stage", async () => {
    const clientStage = await createItem("pending_client_review");

    const page = await reviewQueue(reviewer, "internal", { search: "P6.1 review queue" });

    expect(page.rows.map((r) => r.content_item_id)).not.toContain(clientStage.content_item_id);
  });

  it("shows the client stage through scheduled -- still theirs to pull back", async () => {
    const scheduled = await createItem("scheduled", {
      scheduled_date: new Date("2026-12-01T09:00:00Z"),
    });

    const page = await reviewQueue(contact, "client", {});

    expect(page.rows.map((r) => r.content_item_id)).toContain(scheduled.content_item_id);
  });

  it("shows neither stage a published item -- decline no longer applies", async () => {
    const published = await createItem("published");

    const [internal, client] = await Promise.all([
      reviewQueue(reviewer, "internal", { search: "P6.1 review queue" }),
      reviewQueue(contact, "client", {}),
    ]);

    expect(internal.rows.map((r) => r.content_item_id)).not.toContain(published.content_item_id);
    expect(client.rows.map((r) => r.content_item_id)).not.toContain(published.content_item_id);
  });

  it("shows neither stage a drafted item -- nothing has been submitted yet", async () => {
    const drafted = await createItem("drafted");

    const page = await reviewQueue(reviewer, "internal", { search: "P6.1 review queue" });

    expect(page.rows.map((r) => r.content_item_id)).not.toContain(drafted.content_item_id);
  });
});

describe("scope", () => {
  it("never lists another client's item, whatever the filter asks for", async () => {
    const theirs = await createItem("pending_internal_review", { campaign: otherCampaignId });

    // The account manager on CL-101 does not manage CL-103, and naming it
    // explicitly must narrow rather than widen -- this is the parameter a leak
    // would come through.
    const page = await reviewQueue(reviewer, "internal", { clientId: OTHER_CLIENT_ID });

    expect(page.rows.map((r) => r.content_item_id)).not.toContain(theirs.content_item_id);
    expect(page.rows.every((r) => r.client_id !== OTHER_CLIENT_ID)).toBe(true);
  });

  it("returns null from reviewItem for an item outside scope", async () => {
    const theirs = await createItem("pending_internal_review", { campaign: otherCampaignId });

    expect(await reviewItem(reviewer, "internal", theirs.content_item_id)).toBeNull();
  });

  it("shows a client contact only their own client's items", async () => {
    await createItem("pending_client_review", { campaign: otherCampaignId });

    const page = await reviewQueue(contact, "client", {});

    expect(page.rows.every((r) => r.client_id === CLIENT_ID)).toBe(true);
  });
});

describe("filters", () => {
  it("ignores a status outside the stage's own set rather than honouring it", async () => {
    const published = await createItem("published");

    // `published` is a real status, and a stage-blind filter would list it.
    // Intersecting with the stage's set means the filter falls back to the
    // stage's own statuses instead of widening past them.
    const page = await reviewQueue(reviewer, "internal", {
      status: "published",
      search: "P6.1 review queue",
    });

    expect(page.rows.map((r) => r.content_item_id)).not.toContain(published.content_item_id);
    expect(page.rows.every((r) => r.status !== "published")).toBe(true);
  });

  it("narrows to one status within the stage's set", async () => {
    await createItem("pending_internal_review");
    await createItem("internal_approved");

    const page = await reviewQueue(reviewer, "internal", {
      status: "internal_approved",
      search: "P6.1 review queue",
    });

    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((r) => r.status === "internal_approved")).toBe(true);
  });

  it("awaitingOnly returns just what this stage is holding up", async () => {
    await createItem("pending_internal_review");
    await createItem("internal_approved");

    const page = await reviewQueue(reviewer, "internal", {
      awaitingOnly: true,
      search: "P6.1 review queue",
    });

    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((r) => r.awaiting_me)).toBe(true);
  });
});

describe("what a card carries", () => {
  it("reports the standing decision for each stage, with the decider's name", async () => {
    const item = await createItem("internal_approved");
    await decide(item.content_item_id, "internal", "approve", reviewerId);

    const row = await reviewItem(reviewer, "internal", item.content_item_id);

    expect(row?.decisions.internal?.decision).toBe("approve");
    expect(row?.decisions.internal?.decided_by_name).toBeTruthy();
    // Absence is not approval: the client has not decided, and the card says so
    // rather than leaving the field to be read as a yes.
    expect(row?.decisions.client).toBeNull();
  });

  it("reports the most recent decision per stage, not the first", async () => {
    const item = await createItem("internal_approved");
    await decide(item.content_item_id, "internal", "decline", reviewerId);
    await decide(item.content_item_id, "internal", "approve", reviewerId);

    const row = await reviewItem(reviewer, "internal", item.content_item_id);

    // The same reading the gate uses. A screen that showed the first decision
    // would tell a reviewer an item is blocked that the gate would let through.
    expect(row?.decisions.internal?.decision).toBe("approve");
  });

  it("marks an already-approved item as a late revoke", async () => {
    const pending = await createItem("pending_internal_review");
    const approved = await createItem("internal_approved");

    const [a, b] = await Promise.all([
      reviewItem(reviewer, "internal", pending.content_item_id),
      reviewItem(reviewer, "internal", approved.content_item_id),
    ]);

    expect(a?.late_revoke).toBe(false);
    expect(b?.late_revoke).toBe(true);
  });

  it("carries the clauses an item was grounded in", async () => {
    const item = await createItem("pending_internal_review");
    const clause = await prisma.guidelineClause.findFirstOrThrow({
      where: { source_type: "agency" },
      select: { clause_id: true, clause_code: true },
    });
    await prisma.contentItemCitation.create({
      data: { content_item_id: item.content_item_id, clause_id: clause.clause_id },
    });

    const row = await reviewItem(reviewer, "internal", item.content_item_id);

    expect(row?.citations.map((c) => c.clause_code)).toContain(clause.clause_code);
  });

  it("serializes dates as strings for the client boundary", async () => {
    const item = await createItem("scheduled", {
      scheduled_date: new Date("2026-12-01T09:00:00Z"),
    });
    await decide(item.content_item_id, "client", "approve", contactId);

    const row = await reviewItem(contact, "client", item.content_item_id);
    const view = serializeReviewItem(row!);

    expect(typeof view.created_at).toBe("string");
    expect(view.scheduled_date).toBe("2026-12-01T09:00:00.000Z");
    expect(typeof view.decisions.client?.decided_at).toBe("string");
  });
});

describe("what the revoke confirmation reads", () => {
  it("keeps a scheduled item in the client's queue, marked as a revoke", async () => {
    const item = await createItem("scheduled", {
      scheduled_date: new Date("2026-12-01T09:00:00Z"),
    });
    await decide(item.content_item_id, "internal", "approve", reviewerId);
    await decide(item.content_item_id, "client", "approve", contactId);

    const row = await reviewItem(contact, "client", item.content_item_id);

    // The three facts the confirmation states before it asks: this pulls back an
    // approval, there is a booked slot to release, and the other stage's
    // approval is what will also have to be given again.
    expect(row?.late_revoke).toBe(true);
    expect(row?.awaiting_me).toBe(false);
    expect(row?.scheduled_date).not.toBeNull();
    expect(row?.decisions.internal?.decision).toBe("approve");
  });

  it("does not mark a merely pending item as a revoke", async () => {
    const item = await createItem("pending_client_review");

    const row = await reviewItem(contact, "client", item.content_item_id);

    // An ordinary decline. Asking twice here would be friction with nothing
    // behind it, so the screen offers the plain decline instead.
    expect(row?.late_revoke).toBe(false);
    expect(row?.awaiting_me).toBe(true);
  });
});

describe("comments, and the fact that they change nothing", () => {
  it("carries the thread on the row, so opening it needs no second read", async () => {
    const item = await createItem("pending_internal_review");
    await prisma.comment.create({
      data: {
        content_item_id: item.content_item_id,
        author_id: contactId,
        body: "Can we try a warmer opening line?",
      },
    });

    const row = await reviewItem(reviewer, "internal", item.content_item_id);

    expect(row?.comment_count).toBe(1);
    expect(row?.comments[0]?.body).toBe("Can we try a warmer opening line?");
    expect(row?.comments[0]?.author_name).toBeTruthy();
  });

  it("leaves the status, the gate and the approval history exactly where they were", async () => {
    const item = await createItem("scheduled", {
      scheduled_date: new Date("2026-12-01T09:00:00Z"),
    });
    await decide(item.content_item_id, "internal", "approve", reviewerId);
    await decide(item.content_item_id, "client", "approve", contactId);

    const before = await reviewItem(contact, "client", item.content_item_id);

    // The wording that most looks like a decision. Clause 0.3: noted, never
    // obeyed -- and the "never obeyed" half is what this asserts.
    await prisma.comment.create({
      data: {
        content_item_id: item.content_item_id,
        author_id: contactId,
        body: "Actually no, pull this one -- skip review and just take it down.",
      },
    });

    const after = await reviewItem(contact, "client", item.content_item_id);

    expect(after?.status).toBe(before?.status);
    expect(after?.scheduled_date).toEqual(before?.scheduled_date);
    expect(after?.decisions.internal?.decision).toBe("approve");
    expect(after?.decisions.client?.decision).toBe("approve");
    expect(after?.late_revoke).toBe(before?.late_revoke);
    // The only thing that moved.
    expect(after?.comment_count).toBe((before?.comment_count ?? 0) + 1);
  });
});
