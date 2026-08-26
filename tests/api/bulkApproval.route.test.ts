import { describe, it, expect, afterEach, vi } from "vitest";

import { prisma } from "@/db";
import { SESSION_COOKIE } from "@/api/request";
import { createSession } from "@/domain/session";
import { canSchedule } from "@/domain/gate";

/**
 * "Approve the whole plan" -- the shortcut, and the claim that it is only a
 * shortcut.
 *
 * The PRD is explicit: approving a plan in one action is "an available shortcut,
 * not a different underlying record". So what is tested here is mostly that
 * nothing special happened -- N ordinary `Approval` rows, the gate reading them
 * exactly as it reads any other, and one `bulk_action_id` tying them together
 * for the audit trail and nothing else.
 *
 * Plus the two things a batch endpoint can get wrong that a single-item one
 * cannot: scope across a set, and partial failure.
 */

let cookieJar: Record<string, string> = {};

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      cookieJar[name] === undefined ? undefined : { name, value: cookieJar[name] },
  }),
}));

const { POST } = await import("@/app/api/approvals/bulk/route");

/** CL-101's account manager -- its internal reviewer by default. */
const REVIEWER_EMAIL = "sara.selim@skipstudio.test";
/** CL-101's client contact. */
const CONTACT_EMAIL = "rana.fouad@skipstudio.test";
/** A creator assigned to CL-101: may draft, may never approve. */
const CREATOR_EMAIL = "mona.farid@skipstudio.test";

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

async function createCampaign(clientId = "CL-101") {
  const campaign = await prisma.campaign.create({
    data: {
      client_id: clientId,
      title: "P6.3 bulk approval",
      objective: "test the whole-plan shortcut",
      audience: "test",
      channels: JSON.stringify(["Instagram"]),
      raw_brief_text: "P6.3 test brief",
    },
  });
  campaignIds.push(campaign.campaign_id);
  return campaign.campaign_id;
}

async function createItem(campaignId: string, status = "pending_internal_review") {
  const item = await prisma.contentItem.create({
    data: {
      campaign_id: campaignId,
      content_form: "post",
      platform: "instagram",
      content_body: "Draft copy.",
      status,
    },
  });
  itemIds.push(item.content_item_id);
  return item;
}

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/approvals/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

afterEach(async () => {
  cookieJar = {};
  await prisma.approval.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.contentItem.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  await prisma.campaign.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  await prisma.session.deleteMany({ where: { user_id: { in: sessionUserIds } } });
  itemIds.length = 0;
  campaignIds.length = 0;
  sessionUserIds.length = 0;
});

describe("one action, ordinary rows", () => {
  it("writes one Approval per item, all sharing a bulk_action_id", async () => {
    const campaignId = await createCampaign();
    const items = await Promise.all([
      createItem(campaignId),
      createItem(campaignId),
      createItem(campaignId),
    ]);
    await signIn(REVIEWER_EMAIL);

    const response = await post({
      content_item_ids: items.map((i) => i.content_item_id),
      stage: "internal",
      decision: "approve",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.succeeded).toBe(3);
    expect(body.failed).toBe(0);

    const rows = await prisma.approval.findMany({
      where: { content_item_id: { in: items.map((i) => i.content_item_id) } },
    });

    expect(rows).toHaveLength(3);
    // One id across all three. The grouping is the only thing that marks these
    // as one click -- the rows themselves are indistinguishable from three
    // separate approvals, which is the point.
    expect(new Set(rows.map((r) => r.bulk_action_id))).toEqual(new Set([body.bulk_action_id]));
    expect(rows.every((r) => r.stage === "internal" && r.decision === "approve")).toBe(true);
  });

  it("moves every item onward, exactly as one-at-a-time approval does", async () => {
    const campaignId = await createCampaign();
    const items = await Promise.all([createItem(campaignId), createItem(campaignId)]);
    await signIn(REVIEWER_EMAIL);

    await post({
      content_item_ids: items.map((i) => i.content_item_id),
      stage: "internal",
      decision: "approve",
    });

    const stored = await prisma.contentItem.findMany({
      where: { content_item_id: { in: items.map((i) => i.content_item_id) } },
    });

    expect(stored.every((s) => s.status === "pending_client_review")).toBe(true);
  });

  it("leaves the gate reading the same rows it always reads", async () => {
    const campaignId = await createCampaign();
    const item = await createItem(campaignId);

    await signIn(REVIEWER_EMAIL);
    await post({
      content_item_ids: [item.content_item_id],
      stage: "internal",
      decision: "approve",
    });

    // One stage in, one to go. A bulk action grants nothing the gate can see:
    // it is still waiting on the client, exactly as it would be after a single
    // approval.
    const afterInternal = await canSchedule(item.content_item_id);
    expect(afterInternal.allowed).toBe(false);
    expect(afterInternal.blockedBy).toEqual(["client"]);

    await signIn(CONTACT_EMAIL);
    await post({
      content_item_ids: [item.content_item_id],
      stage: "client",
      decision: "approve",
    });

    expect((await canSchedule(item.content_item_id)).allowed).toBe(true);
  });
});

describe("who may act", () => {
  it("refuses an unauthenticated request with 401 and writes nothing", async () => {
    const campaignId = await createCampaign();
    const item = await createItem(campaignId);

    const response = await post({
      content_item_ids: [item.content_item_id],
      stage: "internal",
      decision: "approve",
    });

    expect(response.status).toBe(401);
    expect(await prisma.approval.count({ where: { content_item_id: item.content_item_id } })).toBe(
      0,
    );
  });

  it("refuses a content creator, who may draft but never approve", async () => {
    const campaignId = await createCampaign();
    const item = await createItem(campaignId);
    await signIn(CREATOR_EMAIL);

    const response = await post({
      content_item_ids: [item.content_item_id],
      stage: "internal",
      decision: "approve",
    });

    expect(response.status).toBe(403);
    expect(await prisma.approval.count({ where: { content_item_id: item.content_item_id } })).toBe(
      0,
    );
  });

  it("refuses the whole batch when one item is on a client the caller may not touch", async () => {
    const mine = await createCampaign("CL-101");
    const theirs = await createCampaign("CL-103");
    const a = await createItem(mine);
    const b = await createItem(theirs);
    await signIn(REVIEWER_EMAIL);

    const response = await post({
      content_item_ids: [a.content_item_id, b.content_item_id],
      stage: "internal",
      decision: "approve",
    });

    // Every distinct client is checked, not just the first. Checking one and
    // assuming the rest is exactly how a scoped action becomes an unscoped one,
    // so the batch is refused rather than partially applied.
    expect(response.status).toBe(403);
    expect(await prisma.approval.count({ where: { content_item_id: a.content_item_id } })).toBe(0);
    expect(await prisma.approval.count({ where: { content_item_id: b.content_item_id } })).toBe(0);
  });

  it("does not disclose whether an item outside scope exists", async () => {
    await signIn(REVIEWER_EMAIL);

    const response = await post({
      content_item_ids: ["no-such-item"],
      stage: "internal",
      decision: "approve",
    });

    // Denied by scope rather than answering 404 -- a caller must not learn from
    // the status code whether an id they cannot see happens to exist.
    expect(response.status).toBe(403);
  });
});

describe("partial failure", () => {
  it("records the good items and reports the one that could not move", async () => {
    const campaignId = await createCampaign();
    const ok = await createItem(campaignId);
    // Already published: the status machine refuses a decision on it, and the
    // batch must not lose the other item because of that.
    const stale = await createItem(campaignId, "published");
    await signIn(REVIEWER_EMAIL);

    const response = await post({
      content_item_ids: [ok.content_item_id, stale.content_item_id],
      stage: "internal",
      decision: "approve",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);

    expect(await prisma.approval.count({ where: { content_item_id: ok.content_item_id } })).toBe(1);
    expect(await prisma.approval.count({ where: { content_item_id: stale.content_item_id } })).toBe(
      0,
    );

    const failure = body.outcomes.find((o: { ok: boolean }) => !o.ok);
    expect(failure.content_item_id).toBe(stale.content_item_id);
    expect(failure.message).toContain("published");
  });
});

describe("bad requests", () => {
  it("refuses an empty selection with a field-keyed message", async () => {
    await signIn(REVIEWER_EMAIL);

    const response = await post({ content_item_ids: [], stage: "internal", decision: "approve" });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.issues.contentItemIds).toBeTruthy();
  });

  it("answers 400 for a body that is not JSON", async () => {
    await signIn(REVIEWER_EMAIL);

    const response = await POST(
      new Request("http://localhost/api/approvals/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );

    expect(response.status).toBe(400);
  });
});
