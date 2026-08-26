import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import { prisma } from "@/db";
import { SESSION_COOKIE } from "@/api/request";
import { createSession } from "@/domain/session";

/**
 * The HTTP shell over `assignItem`.
 *
 * The rules -- who may dispatch, who may be dispatched to, what assignment does
 * not do -- are tested in `lib/domain/taskAssignment.test.ts`. What is tested
 * here is only what the route adds: the acting user comes from the session
 * cookie, a creator is refused, and `assignee_id: null` clears rather than
 * throwing.
 *
 * No mocks beyond the cookie jar: `assignItem` touches no model, so the real
 * one runs against the real database.
 */

let cookieJar: Record<string, string> = {};

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      cookieJar[name] === undefined ? undefined : { name, value: cookieJar[name] },
  }),
}));

const { POST } = await import("@/app/api/content-items/[id]/assign/route");

const LEAD = "TEST-AR-LEAD";
const CREATOR = "TEST-AR-CREATOR";
const USERS = [LEAD, CREATOR];
const CLIENT = "CL-101";

const campaignIds: string[] = [];
const itemIds: string[] = [];

async function signIn(userId: string) {
  const { token } = await createSession({ userId });
  cookieJar[SESSION_COOKIE] = token;
}

function request(assigneeId: string | null) {
  return new Request("http://test/api/content-items/x/assign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignee_id: assigneeId }),
  });
}

async function createItem() {
  const campaign = await prisma.campaign.create({
    data: {
      client_id: CLIENT,
      title: "P14.12b route test",
      raw_brief_text: "test brief",
    },
  });
  campaignIds.push(campaign.campaign_id);

  const item = await prisma.contentItem.create({
    data: {
      campaign_id: campaign.campaign_id,
      content_form: "post",
      content_body: "Draft.",
      status: "drafted",
    },
  });
  itemIds.push(item.content_item_id);
  return item.content_item_id;
}

beforeEach(async () => {
  cookieJar = {};

  for (const id of USERS) {
    await prisma.user.upsert({
      where: { user_id: id },
      update: { status: "active", user_type: "staff", is_agency_admin: false },
      create: {
        user_id: id,
        name: id,
        email: `${id.toLowerCase()}@skipstudio.test`,
        user_type: "staff",
      },
    });
  }

  await prisma.clientAssignment.deleteMany({ where: { user_id: { in: USERS } } });
  await prisma.clientAssignment.createMany({
    data: [
      { client_id: CLIENT, user_id: LEAD, role_on_client: "content_lead" },
      { client_id: CLIENT, user_id: CREATOR, role_on_client: "content_creator" },
    ],
  });
});

afterEach(async () => {
  await prisma.contentItem.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.campaign.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  itemIds.length = 0;
  campaignIds.length = 0;

  await prisma.session.deleteMany({ where: { user_id: { in: USERS } } });
  await prisma.auditLog.deleteMany({ where: { performed_by_id: { in: USERS } } });
  await prisma.flag.deleteMany({ where: { raised_against_id: { in: USERS } } });
  await prisma.clientAssignment.deleteMany({ where: { user_id: { in: USERS } } });
  await prisma.user.deleteMany({ where: { user_id: { in: USERS } } });
});

describe("POST /api/content-items/[id]/assign", () => {
  it("dispatches an item to a creator", async () => {
    await signIn(LEAD);
    const itemId = await createItem();

    const response = await POST(request(CREATOR), { params: { id: itemId } });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.assignee_id).toBe(CREATOR);
    expect(json.previous_assignee_id).toBeNull();
  });

  it("clears an assignment when sent null", async () => {
    await signIn(LEAD);
    const itemId = await createItem();

    await POST(request(CREATOR), { params: { id: itemId } });
    const response = await POST(request(null), { params: { id: itemId } });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.assignee_id).toBeNull();
    expect(json.previous_assignee_id).toBe(CREATOR);
  });

  it("refuses a creator: dispatching is the lead's", async () => {
    await signIn(CREATOR);
    const itemId = await createItem();

    const response = await POST(request(CREATOR), { params: { id: itemId } });

    expect(response.status).toBe(403);
  });

  it("refuses an unauthenticated caller", async () => {
    const itemId = await createItem();

    const response = await POST(request(CREATOR), { params: { id: itemId } });

    expect(response.status).toBe(401);
  });

  it("422s an assignee who is not a creator on that client", async () => {
    await signIn(LEAD);
    const itemId = await createItem();

    // The lead themselves: a real user, holding no creator role here. A fixable
    // request rather than a forbidden one, so 422 and not 403.
    const response = await POST(request(LEAD), { params: { id: itemId } });

    expect(response.status).toBe(422);
  });

  it("404s an item that does not exist", async () => {
    await signIn(LEAD);

    const response = await POST(request(CREATOR), { params: { id: "no-such-item" } });

    expect(response.status).toBe(404);
  });
});
