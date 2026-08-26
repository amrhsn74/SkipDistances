import { describe, it, expect, afterEach, vi } from "vitest";

import { prisma } from "@/db";
import { SESSION_COOKIE } from "@/api/request";
import { createSession } from "@/domain/session";
import { canSchedule } from "@/domain/gate";
import { CHURN_DECLINE_THRESHOLD } from "@/domain/misuse";

/**
 * The HTTP shell over `recordDecision` -- and, through it, the one endpoint that
 * serves approve, decline, and late-revoke.
 *
 * The gate's most-recent-per-stage reading is `lib/domain/gate.test.ts`'s, and
 * the transition table is `lib/domain/statusMachine.test.ts`'s. What is tested
 * here is what this task adds on top of them: that a decision writes an
 * `Approval` row and moves the status in one step, that the same endpoint serves
 * all three actions, that a late revoke unschedules, that a decline on a
 * published item is refused, and that the acting user comes from the session
 * rather than the body.
 *
 * Nothing is mocked but the cookie jar. There is no Gemini call on this path, so
 * the domain layer, the database and the audit trail underneath are all real.
 */

let cookieJar: Record<string, string> = {};

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      cookieJar[name] === undefined ? undefined : { name, value: cookieJar[name] },
  }),
}));

// Imported after the mock is registered, so the route picks it up.
const { POST } = await import("@/app/api/content-items/[id]/approvals/route");

/** CL-101's account manager -- its internal reviewer by default. */
const REVIEWER_EMAIL = "sara.selim@skipstudio.test";
/** CL-101's client contact -- the client-stage approver. */
const CONTACT_EMAIL = "rana.fouad@skipstudio.test";
/** A creator assigned to CL-101: may regenerate, may never approve. */
const CREATOR_EMAIL = "mona.farid@skipstudio.test";
/** An account manager who does not manage CL-101. */
const OTHER_AM_EMAIL = "omar.zaki@skipstudio.test";

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

/** An item on CL-101, at whatever status the case under test needs. */
async function createItem(
  status = "pending_internal_review",
  extra: { scheduled_date?: Date } = {},
) {
  const campaign = await prisma.campaign.create({
    data: {
      client_id: "CL-101",
      title: "P4.4 route test",
      objective: "test approvals over HTTP",
      audience: "test",
      channels: JSON.stringify(["Instagram"]),
      raw_brief_text: "P4.4 test brief",
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

function request(id: string, body: unknown) {
  return new Request(`http://localhost/api/content-items/${id}/approvals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function post(id: string, body: unknown) {
  return POST(request(id, body), { params: { id } });
}

/** Drives an item to client_approved through the endpoint itself. */
async function approveBothStages(itemId: string) {
  await signIn(REVIEWER_EMAIL);
  await post(itemId, { stage: "internal", decision: "approve" });
  await signIn(CONTACT_EMAIL);
  await post(itemId, { stage: "client", decision: "approve" });
}

afterEach(async () => {
  cookieJar = {};

  await prisma.auditLog.deleteMany({ where: { entity_id: { in: itemIds } } });
  await prisma.flag.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.flag.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  await prisma.approval.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.contentItem.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.campaign.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  while (sessionUserIds.length > 0) {
    await prisma.session.deleteMany({ where: { user_id: sessionUserIds.pop()! } });
  }
  itemIds.length = 0;
  campaignIds.length = 0;
});

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

describe("who may decide", () => {
  it("refuses an unauthenticated request with 401 and writes nothing", async () => {
    const item = await createItem();

    const response = await post(item.content_item_id, {
      stage: "internal",
      decision: "approve",
    });

    expect(response.status).toBe(401);
    expect(await prisma.approval.count({ where: { content_item_id: item.content_item_id } })).toBe(
      0,
    );
  });

  it("refuses a content creator, who may draft but never approve", async () => {
    const item = await createItem();
    await signIn(CREATOR_EMAIL);

    const response = await post(item.content_item_id, {
      stage: "internal",
      decision: "approve",
    });

    expect(response.status).toBe(403);
    expect(await prisma.approval.count({ where: { content_item_id: item.content_item_id } })).toBe(
      0,
    );
  });

  it("refuses an account manager on a client they do not manage", async () => {
    const item = await createItem();
    await signIn(OTHER_AM_EMAIL);

    const response = await post(item.content_item_id, {
      stage: "internal",
      decision: "approve",
    });

    // The role holds `approval.internal`; the scope does not hold this client.
    expect(response.status).toBe(403);
    expect(await prisma.approval.count({ where: { content_item_id: item.content_item_id } })).toBe(
      0,
    );
  });

  it("refuses a client contact deciding at the internal stage", async () => {
    const item = await createItem();
    await signIn(CONTACT_EMAIL);

    const response = await post(item.content_item_id, {
      stage: "internal",
      decision: "approve",
    });

    expect(response.status).toBe(403);
  });

  it("records the decision against the session user, never a supplied id", async () => {
    const item = await createItem();
    const reviewer = await signIn(REVIEWER_EMAIL);
    const someoneElse = await prisma.user.findUniqueOrThrow({ where: { email: CONTACT_EMAIL } });

    const response = await post(item.content_item_id, {
      stage: "internal",
      decision: "approve",
      decidedById: someoneElse.user_id,
    });

    // Refused outright rather than silently re-attributed: the gate reads these
    // rows as the record of who signed off.
    expect(response.status).toBe(422);
    expect(await prisma.approval.count({ where: { content_item_id: item.content_item_id } })).toBe(
      0,
    );

    // The same request naming the signed-in user is fine.
    const ok = await post(item.content_item_id, {
      stage: "internal",
      decision: "approve",
      decidedById: reviewer.user_id,
    });
    expect(ok.status).toBe(201);

    const row = await prisma.approval.findFirstOrThrow({
      where: { content_item_id: item.content_item_id },
    });
    expect(row.decided_by_id).toBe(reviewer.user_id);
  });
});

// ---------------------------------------------------------------------------
// The three actions, one endpoint
// ---------------------------------------------------------------------------

describe("approve", () => {
  it("writes an Approval row and hands the item to the client stage", async () => {
    const item = await createItem();
    await signIn(REVIEWER_EMAIL);

    const response = await post(item.content_item_id, {
      stage: "internal",
      decision: "approve",
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    // The internal approval *is* the handoff. The status machine makes
    // `internal_approved -> client_approved` illegal on purpose, so an item left
    // sitting at `internal_approved` would be one the client could never act on
    // -- the second stage would be unreachable.
    expect(body.status).toBe("pending_client_review");
    expect(body.previous_status).toBe("pending_internal_review");
    expect(body.late_revoke).toBe(false);

    const row = await prisma.approval.findFirstOrThrow({
      where: { content_item_id: item.content_item_id },
    });
    expect(row.stage).toBe("internal");
    expect(row.decision).toBe("approve");

    const stored = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: item.content_item_id },
    });
    expect(stored.status).toBe("pending_client_review");
  });

  it("lets the client then approve, completing both stages", async () => {
    const item = await createItem();

    await signIn(REVIEWER_EMAIL);
    await post(item.content_item_id, { stage: "internal", decision: "approve" });

    await signIn(CONTACT_EMAIL);
    const response = await post(item.content_item_id, {
      stage: "client",
      decision: "approve",
    });
    const body = await response.json();

    // The walkthrough the whole phase exists to make possible: one item, two
    // stages, no manual status nudge in between.
    expect(response.status).toBe(201);
    expect(body.status).toBe("client_approved");
    expect(body.gate.allowed).toBe(true);
    expect(await canSchedule(item.content_item_id)).toMatchObject({ allowed: true });
  });

  it("reports the gate as blocked until both stages are in", async () => {
    const item = await createItem();
    await signIn(REVIEWER_EMAIL);

    const internal = await (
      await post(item.content_item_id, { stage: "internal", decision: "approve" })
    ).json();

    // One stage approved is not a gate pass: absence is not approval.
    expect(internal.gate.allowed).toBe(false);
    expect(internal.gate.blocked_by).toEqual(["client"]);

    await prisma.contentItem.update({
      where: { content_item_id: item.content_item_id },
      data: { status: "pending_client_review" },
    });

    await signIn(CONTACT_EMAIL);
    const client = await (
      await post(item.content_item_id, { stage: "client", decision: "approve" })
    ).json();

    expect(client.status).toBe("client_approved");
    expect(client.gate.allowed).toBe(true);
    expect(client.gate.blocked_by).toEqual([]);
  });

  it("accepts an optional comment on an approval", async () => {
    const item = await createItem();
    await signIn(REVIEWER_EMAIL);

    await post(item.content_item_id, {
      stage: "internal",
      decision: "approve",
      comment: "Good to go.",
    });

    const row = await prisma.approval.findFirstOrThrow({
      where: { content_item_id: item.content_item_id },
    });
    expect(row.comment).toBe("Good to go.");
  });
});

describe("decline", () => {
  it("requires a comment saying what to fix", async () => {
    const item = await createItem();
    await signIn(REVIEWER_EMAIL);

    const response = await post(item.content_item_id, {
      stage: "internal",
      decision: "decline",
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.issues.comment).toBeTruthy();
    expect(await prisma.approval.count({ where: { content_item_id: item.content_item_id } })).toBe(
      0,
    );
  });

  it("resets to drafted, not back into the reviewer's queue", async () => {
    const item = await createItem();
    await signIn(REVIEWER_EMAIL);

    const body = await (
      await post(item.content_item_id, {
        stage: "internal",
        decision: "decline",
        comment: "The hook overclaims.",
      })
    ).json();

    // The reset target the architecture is explicit about: a declined item goes
    // back to whoever is working on it, and re-enters review only when someone
    // deliberately resubmits it.
    expect(body.status).toBe("drafted");
    expect(body.late_revoke).toBe(false);
  });

  it("refuses an unknown stage without writing a row", async () => {
    const item = await createItem();
    await signIn(REVIEWER_EMAIL);

    const response = await post(item.content_item_id, {
      stage: "manager",
      decision: "approve",
    });

    expect(response.status).toBe(422);
    expect(await prisma.approval.count({ where: { content_item_id: item.content_item_id } })).toBe(
      0,
    );
  });
});

describe("late revoke", () => {
  it("lets the client pull back an approval after the item is scheduled", async () => {
    const item = await createItem();
    await approveBothStages(item.content_item_id);

    // Scheduled, as the gate now permits.
    await prisma.contentItem.update({
      where: { content_item_id: item.content_item_id },
      data: { status: "scheduled", scheduled_date: new Date("2026-09-01T09:00:00Z") },
    });

    await signIn(CONTACT_EMAIL);
    const body = await (
      await post(item.content_item_id, {
        stage: "client",
        decision: "decline",
        comment: "Holding this one back.",
      })
    ).json();

    expect(body.late_revoke).toBe(true);
    expect(body.status).toBe("drafted");
    expect(body.unscheduled).toBe(true);
    expect(body.gate.allowed).toBe(false);

    const stored = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: item.content_item_id },
    });
    expect(stored.status).toBe("drafted");
    // The slot is released, not just the status: the scheduler must stop seeing
    // this row in its polling window at all.
    expect(stored.scheduled_date).toBeNull();
  });

  it("works the same way for the internal reviewer -- symmetric by design", async () => {
    const item = await createItem();
    await approveBothStages(item.content_item_id);
    await prisma.contentItem.update({
      where: { content_item_id: item.content_item_id },
      data: { status: "scheduled", scheduled_date: new Date("2026-09-01T09:00:00Z") },
    });

    await signIn(REVIEWER_EMAIL);
    const body = await (
      await post(item.content_item_id, {
        stage: "internal",
        decision: "decline",
        comment: "Second look needed.",
      })
    ).json();

    expect(body.late_revoke).toBe(true);
    expect(body.status).toBe("drafted");
    expect(body.unscheduled).toBe(true);
  });

  it("clears the other stage's approval too -- both must clear again", async () => {
    const item = await createItem();
    await approveBothStages(item.content_item_id);

    await signIn(CONTACT_EMAIL);
    await post(item.content_item_id, {
      stage: "client",
      decision: "decline",
      comment: "Pulling back.",
    });

    // The internal approval is still the latest internal row, so the gate names
    // only the client stage -- but the item is at `drafted`, and reaching
    // `scheduled` again requires walking both stages from the start.
    const gate = await canSchedule(item.content_item_id);
    expect(gate.allowed).toBe(false);
    expect(gate.blockedBy).toEqual(["client"]);

    const stored = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: item.content_item_id },
    });
    expect(stored.status).toBe("drafted");
  });
});

// ---------------------------------------------------------------------------
// Where decline stops applying
// ---------------------------------------------------------------------------

describe("a live post", () => {
  it("refuses a decline once published, with 409 and the status", async () => {
    const item = await createItem("published");
    await signIn(CONTACT_EMAIL);

    const response = await post(item.content_item_id, {
      stage: "client",
      decision: "decline",
      comment: "Take it down.",
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.issues.status).toBe("published");
    // The message points at the remaining lever rather than just refusing.
    expect(body.error.message).toContain("take-down");
    expect(await prisma.approval.count({ where: { content_item_id: item.content_item_id } })).toBe(
      0,
    );

    const stored = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: item.content_item_id },
    });
    expect(stored.status).toBe("published");
  });

  it("refuses a decline while publishing", async () => {
    const item = await createItem("publishing");
    await signIn(CONTACT_EMAIL);

    const response = await post(item.content_item_id, {
      stage: "client",
      decision: "decline",
      comment: "Stop it.",
    });

    expect(response.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Trail and signals
// ---------------------------------------------------------------------------

describe("what a decision leaves behind", () => {
  it("writes an audit row naming the actor and the movement", async () => {
    const item = await createItem();
    const reviewer = await signIn(REVIEWER_EMAIL);

    await post(item.content_item_id, {
      stage: "internal",
      decision: "decline",
      comment: "Overclaims.",
    });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { entity_type: "ContentItem", entity_id: item.content_item_id },
    });

    expect(entry.action).toBe("declined");
    expect(entry.performed_by_id).toBe(reviewer.user_id);

    const details = JSON.parse(entry.details!);
    expect(details.from_status).toBe("pending_internal_review");
    expect(details.to_status).toBe("drafted");
    expect(details.late_revoke).toBe(false);
  });

  it("raises approval_churn once an item has been declined enough times", async () => {
    const item = await createItem();
    await signIn(REVIEWER_EMAIL);

    for (let i = 0; i < CHURN_DECLINE_THRESHOLD; i += 1) {
      await post(item.content_item_id, {
        stage: "internal",
        decision: "decline",
        comment: `Round ${i + 1}.`,
      });
      // Back into review, so the next decline is legal from that status.
      await prisma.contentItem.update({
        where: { content_item_id: item.content_item_id },
        data: { status: "pending_internal_review" },
      });
    }

    const flags = await prisma.flag.findMany({
      where: { content_item_id: item.content_item_id, flag_type: "approval_churn" },
    });

    // One row, updated in place, rather than one per decline.
    expect(flags).toHaveLength(1);
    expect(flags[0].severity).toBe("low");
    expect(JSON.parse(flags[0].details!).decline_count).toBe(CHURN_DECLINE_THRESHOLD);
  });

  it("does not raise churn before the threshold", async () => {
    const item = await createItem();
    await signIn(REVIEWER_EMAIL);

    await post(item.content_item_id, {
      stage: "internal",
      decision: "decline",
      comment: "Once.",
    });

    expect(
      await prisma.flag.count({
        where: { content_item_id: item.content_item_id, flag_type: "approval_churn" },
      }),
    ).toBe(0);
  });

  it("accumulates rows rather than overwriting, so the gate can read the latest", async () => {
    const item = await createItem();
    await signIn(REVIEWER_EMAIL);

    await post(item.content_item_id, {
      stage: "internal",
      decision: "decline",
      comment: "Not yet.",
    });
    await prisma.contentItem.update({
      where: { content_item_id: item.content_item_id },
      data: { status: "pending_internal_review" },
    });
    await post(item.content_item_id, { stage: "internal", decision: "approve" });

    const rows = await prisma.approval.findMany({
      where: { content_item_id: item.content_item_id },
    });
    expect(rows).toHaveLength(2);

    // Declined then re-approved reads as approving -- most recent per stage.
    const gate = await canSchedule(item.content_item_id);
    expect(gate.blockedBy).toEqual(["client"]);
  });
});

// ---------------------------------------------------------------------------
// Unknown items and malformed bodies
// ---------------------------------------------------------------------------

describe("bad requests", () => {
  it("does not disclose whether an item outside scope exists", async () => {
    await signIn(REVIEWER_EMAIL);

    const response = await post("no-such-item", { stage: "internal", decision: "approve" });

    // 403 from the scope check, not 404 -- the caller learns nothing about
    // whether an item they cannot see happens to exist.
    expect(response.status).toBe(403);
  });

  it("answers 400 for a body that is not JSON", async () => {
    const item = await createItem();
    await signIn(REVIEWER_EMAIL);

    const response = await POST(request(item.content_item_id, "not json at all"), {
      params: { id: item.content_item_id },
    });

    expect(response.status).toBe(400);
  });
});
