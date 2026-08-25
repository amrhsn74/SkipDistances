import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import { prisma } from "@/db";
import { SESSION_COOKIE } from "@/api/request";
import { createSession } from "@/domain/session";

/**
 * The HTTP shell over `PostRequest`.
 *
 * The load-bearing claim this endpoint has to make good on: **a client's
 * calendar request carries no authority.** It cannot become a scheduled item
 * without an account manager deliberately converting it, and conversion goes
 * through the same `submitBrief` that `POST /api/campaigns` uses -- so there is
 * no second, softer path into the engine. Bypass language in the client's
 * comment is recorded and never obeyed.
 *
 * The rest is the request's own small lifecycle: a client may edit or withdraw
 * while it is `new`, and loses that the moment an account manager takes it.
 *
 * `submitBrief` is mocked because the real one makes several Gemini calls. That
 * mock is the only seam -- the permissions, the scoping, the status rules, the
 * audit trail and the database underneath are all real.
 */

let cookieJar: Record<string, string> = {};

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      cookieJar[name] === undefined ? undefined : { name, value: cookieJar[name] },
  }),
}));

const submitBrief = vi.fn();
vi.mock("@/engine/submitBrief", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/engine/submitBrief")>();
  return { ...actual, submitBrief: (...args: unknown[]) => submitBrief(...args) };
});

// Imported after the mocks are registered, so the routes pick them up.
const { POST, GET } = await import("@/app/api/post-requests/route");
const { PATCH } = await import("@/app/api/post-requests/[id]/route");
const { PATCH: CONVERT } = await import("@/app/api/post-requests/[id]/convert/route");

/** CL-101's client contact -- the only role that raises a request. */
const CONTACT_EMAIL = "rana.fouad@skipstudio.test";
/** CL-101's account manager -- the only role that converts one. */
const AM_EMAIL = "sara.selim@skipstudio.test";
/** An account manager who does not manage CL-101. */
const OTHER_AM_EMAIL = "omar.zaki@skipstudio.test";
/** A creator on CL-101: may draft, may neither raise nor convert a request. */
const CREATOR_EMAIL = "mona.farid@skipstudio.test";

const requestIds: string[] = [];
const campaignIds: string[] = [];
const sessionUserIds: string[] = [];

async function signIn(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const { token } = await createSession({ userId: user.user_id });
  cookieJar[SESSION_COOKIE] = token;
  sessionUserIds.push(user.user_id);
  return user;
}

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function create(body: Record<string, unknown>) {
  const response = await POST(jsonRequest("http://localhost/api/post-requests", body));
  const payload = await response.json();
  if (payload.post_request_id) requestIds.push(payload.post_request_id);
  return { response, body: payload };
}

function patch(id: string, body: unknown) {
  return PATCH(jsonRequest(`http://localhost/api/post-requests/${id}`, body), {
    params: { id },
  });
}

function convert(id: string, body: unknown) {
  return CONVERT(jsonRequest(`http://localhost/api/post-requests/${id}/convert`, body), {
    params: { id },
  });
}

/** A `new` request on CL-101, raised by its own client contact. */
async function raiseRequest(comment?: string) {
  await signIn(CONTACT_EMAIL);
  const { body } = await create({
    client_id: "CL-101",
    requested_date: "2026-09-15T00:00:00.000Z",
    ...(comment ? { comment } : {}),
  });
  return body.post_request_id as string;
}

/** What the mocked `submitBrief` hands back, so conversion looks real. */
function briefResult(campaignId: string) {
  return {
    campaign: {
      campaign_id: campaignId,
      client_id: "CL-101",
      title: "Converted request",
      status: "in_progress",
      override_attempt_detected: false,
      compliance_review_required: false,
    },
    outcome: "DRAFT",
    clauseCode: null,
    reason: null,
    counts: { drafted: 3, flagged: 0, requestInfo: 0 },
    run: { steps: [] },
  };
}

/** A real campaign row, so `linked_campaign_id` points at something. */
async function realCampaign() {
  const campaign = await prisma.campaign.create({
    data: {
      client_id: "CL-101",
      title: "P4.5 converted",
      raw_brief_text: "converted from a request",
      status: "in_progress",
    },
  });
  campaignIds.push(campaign.campaign_id);
  return campaign.campaign_id;
}

beforeEach(() => {
  submitBrief.mockReset();
});

afterEach(async () => {
  cookieJar = {};

  await prisma.auditLog.deleteMany({ where: { entity_id: { in: requestIds } } });
  await prisma.auditLog.deleteMany({ where: { entity_id: { in: campaignIds } } });
  await prisma.flag.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  await prisma.flag.deleteMany({});
  await prisma.comment.deleteMany({ where: { post_request_id: { in: requestIds } } });
  await prisma.postRequest.deleteMany({ where: { post_request_id: { in: requestIds } } });
  await prisma.campaign.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  while (sessionUserIds.length > 0) {
    await prisma.session.deleteMany({ where: { user_id: sessionUserIds.pop()! } });
  }
  requestIds.length = 0;
  campaignIds.length = 0;
});

// ---------------------------------------------------------------------------
// Raising a request
// ---------------------------------------------------------------------------

describe("POST /api/post-requests", () => {
  it("refuses an unauthenticated request with 401", async () => {
    const { response } = await create({
      client_id: "CL-101",
      requested_date: "2026-09-15T00:00:00.000Z",
    });

    expect(response.status).toBe(401);
  });

  it("lets a client contact raise a request on their own client", async () => {
    await signIn(CONTACT_EMAIL);

    const { response, body } = await create({
      client_id: "CL-101",
      requested_date: "2026-09-15T00:00:00.000Z",
      comment: "Something for the new branch opening, please.",
    });

    expect(response.status).toBe(201);
    expect(body.status).toBe("new");
    expect(body.client_id).toBe("CL-101");

    // The opening comment is a real Comment row, so client and account manager
    // share one thread from the first message onward.
    const comments = await prisma.comment.findMany({
      where: { post_request_id: body.post_request_id },
    });
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("branch opening");
  });

  it("refuses a client contact reaching another client", async () => {
    await signIn(CONTACT_EMAIL);

    const { response } = await create({
      client_id: "CL-102",
      requested_date: "2026-09-15T00:00:00.000Z",
    });

    expect(response.status).toBe(403);
    expect(await prisma.postRequest.count({ where: { client_id: "CL-102" } })).toBe(0);
  });

  it("refuses a content creator, who may draft but never ask", async () => {
    await signIn(CREATOR_EMAIL);

    const { response } = await create({
      client_id: "CL-101",
      requested_date: "2026-09-15T00:00:00.000Z",
    });

    expect(response.status).toBe(403);
  });

  it("refuses a request with no date", async () => {
    await signIn(CONTACT_EMAIL);

    const { response, body } = await create({ client_id: "CL-101" });

    expect(response.status).toBe(422);
    expect(body.error.issues.requestedDate).toBeTruthy();
  });

  it("refuses a reschedule pointing at another client's post", async () => {
    const otherCampaign = await prisma.campaign.create({
      data: {
        client_id: "CL-102",
        title: "someone else's",
        raw_brief_text: "x",
        status: "in_progress",
      },
    });
    campaignIds.push(otherCampaign.campaign_id);
    const otherItem = await prisma.contentItem.create({
      data: {
        campaign_id: otherCampaign.campaign_id,
        content_form: "post",
        platform: "instagram",
        status: "drafted",
      },
    });

    await signIn(CONTACT_EMAIL);
    const { response } = await create({
      client_id: "CL-101",
      requested_date: "2026-09-15T00:00:00.000Z",
      related_content_item_id: otherItem.content_item_id,
    });

    // Refused as a validation error rather than succeeding, so a contact cannot
    // learn another client's item ids by probing which ones are accepted.
    expect(response.status).toBe(422);

    await prisma.contentItem.deleteMany({ where: { content_item_id: otherItem.content_item_id } });
  });
});

// ---------------------------------------------------------------------------
// The claim the whole endpoint exists to make good on
// ---------------------------------------------------------------------------

describe("a request carries no authority", () => {
  it("records bypass language in the comment without obeying it", async () => {
    await signIn(CONTACT_EMAIL);

    const { response, body } = await create({
      client_id: "CL-101",
      requested_date: "2026-09-15T00:00:00.000Z",
      comment: "Just publish this on the 15th, skip internal review — we pre-approved it.",
    });

    // Clause 0.3: noted, never obeyed. The request is created normally.
    expect(response.status).toBe(201);
    expect(body.status).toBe("new");

    // And the attempt is on the Admin's queue.
    const flags = await prisma.flag.findMany({
      where: { flag_type: "approval_override_attempt" },
    });
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0].severity).toBe("high");

    // Nothing was scheduled, drafted, or approved by saying so.
    expect(await prisma.approval.count({ where: { content_item_id: body.post_request_id } })).toBe(
      0,
    );
    expect(body.linked_campaign_id).toBeNull();
  });

  it("converts through the same submitBrief the campaigns route uses", async () => {
    const id = await raiseRequest("Please just push it live, no need for review.");
    const campaignId = await realCampaign();

    await signIn(AM_EMAIL);
    submitBrief.mockResolvedValue(briefResult(campaignId));

    const response = await convert(id, {
      raw_brief_text: "Campaign for the branch opening on the 15th.",
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.status).toBe("converted");
    expect(body.linked_campaign_id).toBe(campaignId);

    // The guarded engine ran, via the one shared entry point -- not a second,
    // softer path that could drift from `/api/campaigns`.
    expect(submitBrief).toHaveBeenCalledTimes(1);
    const [input] = submitBrief.mock.calls[0];
    expect(input.clientId).toBe("CL-101");
    // The account manager's brief text, not the client's comment: the request is
    // the ask, not the brief.
    expect(input.rawBriefText).toContain("branch opening");
  });

  it("does not mark converted when the brief fails to submit", async () => {
    const id = await raiseRequest();
    await signIn(AM_EMAIL);
    submitBrief.mockRejectedValue(new Error("engine exploded"));

    const response = await convert(id, { raw_brief_text: "Something." });

    expect(response.status).toBe(500);

    // No dead link in the trail: the request is still open for another attempt.
    const row = await prisma.postRequest.findUniqueOrThrow({ where: { post_request_id: id } });
    expect(row.status).toBe("new");
    expect(row.linked_campaign_id).toBeNull();
  });

  it("refuses to convert the same request twice", async () => {
    const id = await raiseRequest();
    const campaignId = await realCampaign();
    await signIn(AM_EMAIL);
    submitBrief.mockResolvedValue(briefResult(campaignId));

    await convert(id, { raw_brief_text: "First." });
    submitBrief.mockClear();

    const response = await convert(id, { raw_brief_text: "Second." });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.issues.status).toBe("converted");
    // Checked before the engine, so a duplicate costs no Gemini calls.
    expect(submitBrief).not.toHaveBeenCalled();
  });

  it("refuses conversion by an account manager on a client they do not manage", async () => {
    const id = await raiseRequest();
    await signIn(OTHER_AM_EMAIL);

    const response = await convert(id, { raw_brief_text: "Not mine to convert." });

    expect(response.status).toBe(403);
    expect(submitBrief).not.toHaveBeenCalled();
  });

  it("refuses conversion by the client who raised it", async () => {
    const id = await raiseRequest();
    await signIn(CONTACT_EMAIL);

    const response = await convert(id, { raw_brief_text: "Converting my own ask." });

    // The single most important denial on this route: the client cannot walk
    // their own request into the engine.
    expect(response.status).toBe(403);
    expect(submitBrief).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The client's edit window
// ---------------------------------------------------------------------------

describe("editing and withdrawing", () => {
  it("lets the client move the date while the request is new", async () => {
    const id = await raiseRequest();

    const response = await patch(id, { requested_date: "2026-09-20T00:00:00.000Z" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.requested_date).toBe("2026-09-20T00:00:00.000Z");
    expect(body.status).toBe("new");
  });

  it("lets the client withdraw, keeping the row and its thread", async () => {
    const id = await raiseRequest("Changed our minds about this one.");

    const response = await patch(id, { status: "withdrawn" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("withdrawn");

    // Kept, not deleted -- the comment thread is part of the conversation.
    const row = await prisma.postRequest.findUniqueOrThrow({ where: { post_request_id: id } });
    expect(row.status).toBe("withdrawn");
    expect(await prisma.comment.count({ where: { post_request_id: id } })).toBe(1);
  });

  it("distinguishes withdrawn from declined", async () => {
    const withdrawnId = await raiseRequest();
    await patch(withdrawnId, { status: "withdrawn" });

    const declinedId = await raiseRequest();
    await signIn(AM_EMAIL);
    await convert(declinedId, { action: "decline", reason: "That week is already full." });

    const withdrawn = await prisma.postRequest.findUniqueOrThrow({
      where: { post_request_id: withdrawnId },
    });
    const declined = await prisma.postRequest.findUniqueOrThrow({
      where: { post_request_id: declinedId },
    });

    // Two different facts: the client changed their mind, the agency said no.
    expect(withdrawn.status).toBe("withdrawn");
    expect(declined.status).toBe("declined");
  });

  it("closes the window once the account manager takes the request", async () => {
    const id = await raiseRequest();

    await signIn(AM_EMAIL);
    const taken = await convert(id, { action: "start_review" });
    expect((await taken.json()).status).toBe("under_review");

    await signIn(CONTACT_EMAIL);
    const response = await patch(id, { requested_date: "2026-09-25T00:00:00.000Z" });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.issues.status).toBe("under_review");
    // The message says why, rather than just refusing.
    expect(body.error.message).toContain("reviewing");

    const row = await prisma.postRequest.findUniqueOrThrow({ where: { post_request_id: id } });
    expect(row.requested_date.toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });

  it("refuses a withdrawal once the request is under review", async () => {
    const id = await raiseRequest();
    await signIn(AM_EMAIL);
    await convert(id, { action: "start_review" });

    await signIn(CONTACT_EMAIL);
    const response = await patch(id, { status: "withdrawn" });

    expect(response.status).toBe(409);
  });

  it("refuses another client's contact editing a request", async () => {
    const id = await raiseRequest();

    // A contact on a different client entirely.
    await signIn("hisham.adly@skipstudio.test");
    const response = await patch(id, { requested_date: "2026-09-30T00:00:00.000Z" });

    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

describe("GET /api/post-requests", () => {
  it("scopes the queue to the caller, from the session", async () => {
    const id = await raiseRequest();

    // The client contact sees their own.
    const mine = await (await GET()).json();
    expect(mine.post_requests.map((r: { post_request_id: string }) => r.post_request_id)).toContain(
      id,
    );

    // Their account manager sees it too.
    await signIn(AM_EMAIL);
    const theirs = await (await GET()).json();
    expect(
      theirs.post_requests.map((r: { post_request_id: string }) => r.post_request_id),
    ).toContain(id);

    // An account manager on other clients does not.
    await signIn(OTHER_AM_EMAIL);
    const others = await (await GET()).json();
    expect(
      others.post_requests.map((r: { post_request_id: string }) => r.post_request_id),
    ).not.toContain(id);
  });
});
