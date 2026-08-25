import { describe, it, expect, afterEach, vi } from "vitest";

import { prisma } from "@/db";
import { SESSION_COOKIE } from "@/api/request";
import { createSession } from "@/domain/session";
import { canSchedule } from "@/domain/gate";

/**
 * The HTTP shell over `Comment`.
 *
 * The plan asks for "a one-line test asserting it" -- that a comment has no
 * status side-effects, ever. It is written out at more length than one line
 * because the interesting cases are the ones where a comment most *looks* like a
 * decision: a client writing "approved, go ahead", an override attempt, a
 * message on an already-scheduled item. Each of those reads the item's status
 * and the gate's answer before and after, and asserts both are unchanged.
 *
 * That is the assertion the approval gate's integrity rests on from this
 * direction. `gate.test.ts` proves the gate reads the most recent `Approval` per
 * stage; this proves a `Comment` never becomes one of those rows.
 *
 * Nothing is mocked but the cookie jar. There is no Gemini call on this path, so
 * the permissions, the scoping, the database and the audit trail underneath are
 * all real.
 */

let cookieJar: Record<string, string> = {};

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      cookieJar[name] === undefined ? undefined : { name, value: cookieJar[name] },
  }),
}));

// Imported after the mock is registered, so the route picks it up.
const { POST, GET } = await import("@/app/api/comments/route");

/** CL-101's account manager -- its internal reviewer by default. */
const AM_EMAIL = "sara.selim@skipstudio.test";
/** CL-101's client contact. */
const CONTACT_EMAIL = "rana.fouad@skipstudio.test";
/** A creator assigned to CL-101. */
const CREATOR_EMAIL = "mona.farid@skipstudio.test";
/** A contact on a different client entirely (CL-102's). */
const OTHER_CONTACT_EMAIL = "hisham.adly@skipstudio.test";

const campaignIds: string[] = [];
const itemIds: string[] = [];
const requestIds: string[] = [];
const commentIds: string[] = [];
const sessionUserIds: string[] = [];

async function signIn(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const { token } = await createSession({ userId: user.user_id });
  cookieJar[SESSION_COOKIE] = token;
  sessionUserIds.push(user.user_id);
  return user;
}

function jsonRequest(body: unknown) {
  return new Request("http://localhost/api/comments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function post(body: Record<string, unknown>) {
  const response = await POST(jsonRequest(body));
  const payload = await response.json();
  if (payload.comment_id) commentIds.push(payload.comment_id);
  return { response, body: payload };
}

/** An item on CL-101, at whatever status the case under test needs. */
async function createItem(status = "pending_client_review", scheduledDate?: Date) {
  const campaign = await prisma.campaign.create({
    data: {
      client_id: "CL-101",
      title: "P4.7 route test",
      objective: "test comments over HTTP",
      audience: "test",
      channels: JSON.stringify(["Instagram"]),
      raw_brief_text: "P4.7 test brief",
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
      ...(scheduledDate ? { scheduled_date: scheduledDate } : {}),
    },
  });
  itemIds.push(item.content_item_id);
  return item.content_item_id;
}

/** A `new` request on CL-101. */
async function createRequest() {
  const contact = await prisma.user.findUniqueOrThrow({ where: { email: CONTACT_EMAIL } });
  const row = await prisma.postRequest.create({
    data: {
      client_id: "CL-101",
      requested_by_id: contact.user_id,
      requested_date: new Date("2026-10-01T00:00:00.000Z"),
      status: "new",
    },
  });
  requestIds.push(row.post_request_id);
  return row.post_request_id;
}

/** An item both stages have currently approved -- so the gate says true. */
async function approvedItem(status = "client_approved") {
  const id = await createItem(status);
  const reviewer = await prisma.user.findUniqueOrThrow({ where: { email: AM_EMAIL } });
  const contact = await prisma.user.findUniqueOrThrow({ where: { email: CONTACT_EMAIL } });

  await prisma.approval.create({
    data: {
      content_item_id: id,
      stage: "internal",
      decision: "approve",
      decided_by_id: reviewer.user_id,
    },
  });
  await prisma.approval.create({
    data: {
      content_item_id: id,
      stage: "client",
      decision: "approve",
      decided_by_id: contact.user_id,
    },
  });

  return id;
}

/**
 * The item's status and the gate's verdict, as one comparable snapshot.
 *
 * `canSchedule` is reduced to its `allowed` boolean rather than kept whole: the
 * full `GateResult` carries the `Approval` rows it read, including their
 * `decided_at` timestamps, and comparing those would make this assert that the
 * rows are byte-identical rather than that the verdict is unchanged. The
 * approval count alongside it is what catches a new row appearing.
 */
async function snapshot(itemId: string) {
  const item = await prisma.contentItem.findUniqueOrThrow({
    where: { content_item_id: itemId },
    select: { status: true, scheduled_date: true, content_body: true },
  });
  return {
    ...item,
    gateAllows: (await canSchedule(itemId)).allowed,
    approvalCount: await prisma.approval.count({ where: { content_item_id: itemId } }),
  };
}

afterEach(async () => {
  cookieJar = {};

  await prisma.auditLog.deleteMany({ where: { entity_id: { in: commentIds } } });
  await prisma.auditLog.deleteMany({ where: { entity_id: { in: itemIds } } });
  await prisma.auditLog.deleteMany({ where: { entity_id: { in: requestIds } } });
  await prisma.auditLog.deleteMany({ where: { entity_id: { in: campaignIds } } });
  await prisma.flag.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.flag.deleteMany({ where: { flag_type: "approval_override_attempt" } });
  await prisma.flag.deleteMany({ where: { flag_type: "role_boundary_violation" } });
  await prisma.comment.deleteMany({ where: { comment_id: { in: commentIds } } });
  await prisma.approval.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.postRequest.deleteMany({ where: { post_request_id: { in: requestIds } } });
  await prisma.contentItem.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.campaign.deleteMany({ where: { campaign_id: { in: campaignIds } } });

  while (sessionUserIds.length > 0) {
    await prisma.session.deleteMany({ where: { user_id: sessionUserIds.pop()! } });
  }
  commentIds.length = 0;
  itemIds.length = 0;
  requestIds.length = 0;
  campaignIds.length = 0;
});

// ---------------------------------------------------------------------------
// The assertion this endpoint exists for
// ---------------------------------------------------------------------------

describe("a comment never has a status side-effect", () => {
  it("leaves an item awaiting client review exactly where it was", async () => {
    const id = await createItem("pending_client_review");
    const before = await snapshot(id);

    await signIn(CONTACT_EMAIL);
    const { response } = await post({ content_item_id: id, body: "Love the second line." });

    expect(response.status).toBe(201);
    expect(await snapshot(id)).toEqual(before);
  });

  it("does not approve, however much the wording sounds like approval", async () => {
    const id = await createItem("pending_client_review");
    const before = await snapshot(id);

    await signIn(CONTACT_EMAIL);
    await post({
      content_item_id: id,
      body: "Approved! This is perfect, go ahead and publish it today.",
    });

    const after = await snapshot(id);
    expect(after).toEqual(before);
    // The gate reads Approval rows. A comment is not one, so the count is still
    // zero and the gate still refuses.
    expect(after.approvalCount).toBe(0);
    expect(after.gateAllows).toBe(false);
  });

  it("does not withdraw an approval, however much it sounds like a decline", async () => {
    const id = await approvedItem("client_approved");
    const before = await snapshot(id);
    expect(before.gateAllows).toBe(true);

    await signIn(CONTACT_EMAIL);
    await post({
      content_item_id: id,
      body: "Actually I've changed my mind, please pull this one, we don't want it.",
    });

    // Still approved. Withdrawing takes a formal decline through
    // POST /api/content-items/[id]/approvals -- which is the whole distinction.
    const after = await snapshot(id);
    expect(after).toEqual(before);
    expect(after.gateAllows).toBe(true);
  });

  it("does not unschedule a scheduled item", async () => {
    const id = await approvedItem("scheduled");
    await prisma.contentItem.update({
      where: { content_item_id: id },
      data: { scheduled_date: new Date("2026-11-01T09:00:00.000Z") },
    });
    const before = await snapshot(id);

    await signIn(CONTACT_EMAIL);
    await post({ content_item_id: id, body: "Can we move this to the Thursday instead?" });

    const after = await snapshot(id);
    expect(after).toEqual(before);
    expect(after.status).toBe("scheduled");
    expect(after.scheduled_date).toEqual(before.scheduled_date);
  });

  it("records an override attempt and still changes nothing", async () => {
    const id = await createItem("pending_internal_review");
    const before = await snapshot(id);

    const contact = await signIn(CONTACT_EMAIL);
    const { response } = await post({
      content_item_id: id,
      body: "Skip internal review on this one -- the client pre-approved it already.",
    });

    // The comment is stored normally. Clause 0.3: noted, never obeyed.
    expect(response.status).toBe(201);
    expect(await snapshot(id)).toEqual(before);

    // The noted half: a flag the Admin will see, naming who wrote it.
    const flags = await prisma.flag.findMany({
      where: { flag_type: "approval_override_attempt", raised_against_id: contact.user_id },
    });
    expect(flags.length).toBeGreaterThan(0);
  });

  it("does not edit the content body -- a comment is not a revision", async () => {
    const id = await createItem("drafted");
    const before = await snapshot(id);

    await signIn(CREATOR_EMAIL);
    await post({ content_item_id: id, body: "Change the opener to 'Morning, Cairo.'" });

    expect((await snapshot(id)).content_body).toBe(before.content_body);
  });
});

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

describe("POST /api/comments", () => {
  it("refuses an unauthenticated request with 401", async () => {
    const id = await createItem();

    const { response } = await post({ content_item_id: id, body: "Hello?" });

    expect(response.status).toBe(401);
  });

  it("posts on a content item", async () => {
    const id = await createItem();

    const contact = await signIn(CONTACT_EMAIL);
    const { response, body } = await post({ content_item_id: id, body: "Nice work." });

    expect(response.status).toBe(201);
    expect(body.content_item_id).toBe(id);
    expect(body.post_request_id).toBeNull();
    expect(body.author_id).toBe(contact.user_id);
    expect(body.body).toBe("Nice work.");
  });

  it("posts on a post request", async () => {
    const id = await createRequest();

    await signIn(CONTACT_EMAIL);
    const { response, body } = await post({
      post_request_id: id,
      body: "Could we make this the Thursday?",
    });

    expect(response.status).toBe(201);
    expect(body.post_request_id).toBe(id);
    expect(body.content_item_id).toBeNull();
  });

  it("takes the author from the session, not the body", async () => {
    const id = await createItem();
    const other = await prisma.user.findUniqueOrThrow({ where: { email: AM_EMAIL } });

    const contact = await signIn(CONTACT_EMAIL);
    const { body } = await post({
      content_item_id: id,
      body: "Who wrote this?",
      author_id: other.user_id,
    });

    expect(body.author_id).toBe(contact.user_id);
    expect(body.author_id).not.toBe(other.user_id);
  });

  it("rejects a comment with both targets set", async () => {
    const itemId = await createItem();
    const requestId = await createRequest();

    await signIn(CONTACT_EMAIL);
    const { response, body } = await post({
      content_item_id: itemId,
      post_request_id: requestId,
      body: "Which thread is this?",
    });

    expect(response.status).toBe(422);
    expect(body.error.issues.target).toBeTruthy();
  });

  it("rejects a comment with neither target set", async () => {
    await signIn(CONTACT_EMAIL);

    const { response, body } = await post({ body: "About what?" });

    expect(response.status).toBe(422);
    expect(body.error.issues.target).toBeTruthy();
  });

  it("rejects an empty body", async () => {
    const id = await createItem();

    await signIn(CONTACT_EMAIL);
    const { response, body } = await post({ content_item_id: id, body: "   " });

    expect(response.status).toBe(422);
    expect(body.error.issues.body).toBeTruthy();
  });

  it("answers 404 for a target that does not exist", async () => {
    await signIn(CONTACT_EMAIL);

    const { response } = await post({ content_item_id: "no-such-item", body: "Hello?" });

    expect(response.status).toBe(404);
  });

  it("refuses a contact commenting on another client's item, with 403", async () => {
    const id = await createItem();

    await signIn(OTHER_CONTACT_EMAIL);
    const { response } = await post({ content_item_id: id, body: "What is this?" });

    expect(response.status).toBe(403);

    // And nothing was written.
    const rows = await prisma.comment.findMany({ where: { content_item_id: id } });
    expect(rows).toHaveLength(0);
  });

  it("lets every role on the client join the thread", async () => {
    const id = await createItem();

    for (const email of [AM_EMAIL, CREATOR_EMAIL, CONTACT_EMAIL]) {
      await signIn(email);
      const { response } = await post({ content_item_id: id, body: `From ${email}.` });
      expect(response.status, `${email} could not comment`).toBe(201);
    }
  });
});

// ---------------------------------------------------------------------------
// Reading a thread
// ---------------------------------------------------------------------------

describe("GET /api/comments", () => {
  it("returns a thread oldest first", async () => {
    const id = await createItem();

    await signIn(CONTACT_EMAIL);
    await post({ content_item_id: id, body: "First." });
    await post({ content_item_id: id, body: "Second." });

    const response = await GET(
      new Request(`http://localhost/api/comments?content_item_id=${id}`),
    );
    const body = await response.json();

    expect(body.comments.map((c: { body: string }) => c.body)).toEqual(["First.", "Second."]);
  });

  it("refuses another client's thread with 403", async () => {
    const id = await createItem();

    await signIn(CONTACT_EMAIL);
    await post({ content_item_id: id, body: "Ours." });

    await signIn(OTHER_CONTACT_EMAIL);
    const response = await GET(
      new Request(`http://localhost/api/comments?content_item_id=${id}`),
    );

    expect(response.status).toBe(403);
  });
});
