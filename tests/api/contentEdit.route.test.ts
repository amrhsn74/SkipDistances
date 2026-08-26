import { describe, it, expect, afterEach, vi } from "vitest";

import { prisma } from "@/db";
import { SESSION_COOKIE } from "@/api/request";
import { createSession } from "@/domain/session";
import { canSchedule } from "@/domain/gate";

/**
 * A creator editing a draft by hand -- and the invalidation that follows it.
 *
 * The transition table is `statusMachine.test.ts`'s. What is tested here is that
 * a hand edit actually goes through it: the PRD's "one rule, applied the same way
 * regardless of cause" is only true if the typed-text path resets exactly as a
 * regeneration and a late decline do, and this is the path where a well-meaning
 * "it was only a small change" shortcut would be added.
 */

let cookieJar: Record<string, string> = {};

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      cookieJar[name] === undefined ? undefined : { name, value: cookieJar[name] },
  }),
}));

const { PATCH } = await import("@/app/api/content-items/[id]/route");

/** A creator assigned to CL-101. */
const CREATOR_EMAIL = "mona.farid@skipstudio.test";
/** A creator assigned to CL-103, not CL-101. */
const OTHER_CREATOR_EMAIL = "nour.kamal@skipstudio.test";
/** CL-101's client contact -- may approve, may never edit a draft. */
const CONTACT_EMAIL = "rana.fouad@skipstudio.test";
/** CL-101's account manager. */
const REVIEWER_EMAIL = "sara.selim@skipstudio.test";

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

async function createItem(status = "drafted", extra: { scheduled_date?: Date } = {}) {
  const campaign = await prisma.campaign.create({
    data: {
      client_id: "CL-101",
      title: "P7.2 edit route test",
      objective: "test editing over HTTP",
      audience: "test",
      channels: JSON.stringify(["Instagram"]),
      raw_brief_text: "P7.2 test brief",
    },
  });
  campaignIds.push(campaign.campaign_id);

  const item = await prisma.contentItem.create({
    data: {
      campaign_id: campaign.campaign_id,
      content_form: "post",
      platform: "instagram",
      content_body: "Original copy.",
      status,
      ...extra,
    },
  });
  itemIds.push(item.content_item_id);
  return item;
}

/** Both stages approved, as the gate would read them. */
async function approveBothStages(contentItemId: string) {
  const reviewer = await prisma.user.findUniqueOrThrow({ where: { email: REVIEWER_EMAIL } });
  const contact = await prisma.user.findUniqueOrThrow({ where: { email: CONTACT_EMAIL } });

  await prisma.approval.create({
    data: {
      content_item_id: contentItemId,
      stage: "internal",
      decision: "approve",
      decided_by_id: reviewer.user_id,
    },
  });
  await prisma.approval.create({
    data: {
      content_item_id: contentItemId,
      stage: "client",
      decision: "approve",
      decided_by_id: contact.user_id,
    },
  });
}

function patch(id: string, body: unknown) {
  return PATCH(
    new Request(`http://localhost/api/content-items/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: { id } },
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

describe("who may edit", () => {
  it("refuses an unauthenticated request with 401 and changes nothing", async () => {
    const item = await createItem();

    const response = await patch(item.content_item_id, { content_body: "Rewritten." });

    expect(response.status).toBe(401);
    const stored = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: item.content_item_id },
    });
    expect(stored.content_body).toBe("Original copy.");
  });

  it("refuses a client contact, who approves but never drafts", async () => {
    const item = await createItem();
    await signIn(CONTACT_EMAIL);

    const response = await patch(item.content_item_id, { content_body: "Rewritten." });

    expect(response.status).toBe(403);
  });

  it("refuses a creator on a client they are not assigned to", async () => {
    const item = await createItem();
    await signIn(OTHER_CREATOR_EMAIL);

    const response = await patch(item.content_item_id, { content_body: "Rewritten." });

    expect(response.status).toBe(403);
  });

  it("does not disclose whether an item outside scope exists", async () => {
    await signIn(CREATOR_EMAIL);

    const response = await patch("no-such-item", { content_body: "Rewritten." });

    expect(response.status).toBe(403);
  });
});

describe("saving a draft", () => {
  it("stores the new text and leaves an unapproved draft where it was", async () => {
    const item = await createItem("drafted");
    await signIn(CREATOR_EMAIL);

    const response = await patch(item.content_item_id, { content_body: "Rewritten copy." });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("drafted");
    // Nothing had been approved, so nothing was lost.
    expect(body.reset_approvals).toBe(false);

    const stored = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: item.content_item_id },
    });
    expect(stored.content_body).toBe("Rewritten copy.");
  });

  it("refuses an empty body rather than treating it as a deletion", async () => {
    const item = await createItem();
    await signIn(CREATOR_EMAIL);

    const response = await patch(item.content_item_id, { content_body: "   " });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.issues.contentBody).toBeTruthy();
  });

  it("writes an audit row naming the editor", async () => {
    const item = await createItem();
    const creator = await signIn(CREATOR_EMAIL);

    await patch(item.content_item_id, { content_body: "Rewritten copy." });

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entity_id: item.content_item_id, action: "edited" },
      orderBy: { performed_at: "desc" },
    });
    expect(audit.performed_by_id).toBe(creator.user_id);
  });
});

describe("the invalidation an edit causes", () => {
  it("resets an approved item to drafted and clears the gate", async () => {
    const item = await createItem("client_approved");
    await approveBothStages(item.content_item_id);
    expect((await canSchedule(item.content_item_id)).allowed).toBe(true);

    await signIn(CREATOR_EMAIL);
    const body = await (
      await patch(item.content_item_id, { content_body: "Rewritten after approval." })
    ).json();

    // The same reset a late decline produces. One rule, no per-cause branching.
    expect(body.status).toBe("drafted");
    expect(body.reset_approvals).toBe(true);

    const stored = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: item.content_item_id },
    });
    expect(stored.status).toBe("drafted");
  });

  it("releases a booked slot when the edited item was scheduled", async () => {
    const item = await createItem("scheduled", {
      scheduled_date: new Date("2026-09-01T09:00:00Z"),
    });
    await approveBothStages(item.content_item_id);

    await signIn(CREATOR_EMAIL);
    const body = await (
      await patch(item.content_item_id, { content_body: "Rewritten after scheduling." })
    ).json();

    expect(body.status).toBe("drafted");
    expect(body.unscheduled).toBe(true);

    const stored = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: item.content_item_id },
    });
    // The slot, not just the status: the scheduler must stop seeing this row in
    // its polling window at all.
    expect(stored.scheduled_date).toBeNull();
  });

  it("refuses an edit once the item is published, with 409 and the status", async () => {
    const item = await createItem("published");
    await signIn(CREATOR_EMAIL);

    const response = await patch(item.content_item_id, { content_body: "Too late." });
    const body = await response.json();

    // The same boundary a decline stops at: a live post is changed by a
    // take-down, not by editing the row underneath it.
    expect(response.status).toBe(409);
    expect(body.error.issues.status).toBe("published");

    const stored = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: item.content_item_id },
    });
    expect(stored.content_body).toBe("Original copy.");
  });
});

describe("submitting for review", () => {
  it("moves a draft to pending_internal_review", async () => {
    const item = await createItem("drafted");
    await signIn(CREATOR_EMAIL);

    const body = await (await patch(item.content_item_id, { action: "submit" })).json();

    expect(body.previous_status).toBe("drafted");
    expect(body.status).toBe("pending_internal_review");
  });

  it("submits a flagged item once fixed, and clears the flag", async () => {
    const clause = await prisma.guidelineClause.findFirstOrThrow({
      where: { source_type: "agency" },
      select: { clause_id: true },
    });
    const item = await createItem("flagged");
    await prisma.contentItem.update({
      where: { content_item_id: item.content_item_id },
      data: { flagged_clause_id: clause.clause_id },
    });

    await signIn(CREATOR_EMAIL);
    const body = await (await patch(item.content_item_id, { action: "submit" })).json();

    expect(body.status).toBe("pending_internal_review");

    const stored = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: item.content_item_id },
    });
    // The flag described the draft that was refused. Carrying it onto the fixed
    // version would show a reviewer a violation that may no longer be there.
    expect(stored.flagged_clause_id).toBeNull();
  });

  it("refuses to submit something already in review", async () => {
    const item = await createItem("pending_internal_review");
    await signIn(CREATOR_EMAIL);

    const response = await patch(item.content_item_id, { action: "submit" });

    expect(response.status).toBe(409);
  });
});
