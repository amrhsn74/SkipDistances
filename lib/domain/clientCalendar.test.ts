import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";

import { prisma } from "../db";
import { clientCalendar, incomingRequests } from "./clientCalendar";

/**
 * What a client sees on their calendar, and what their account manager sees of
 * the same rows.
 *
 * The `PostRequest` lifecycle is `postRequests.ts`'s and is tested through the
 * route. What is tested here is the two reads the dashboard is built on: that a
 * client's calendar is their own, that a request stays visible while it is still
 * theirs to withdraw, and that the edit window the UI draws matches the one the
 * API enforces -- a screen offering a control the server refuses is worse than
 * one that offers nothing.
 */

const CLIENT_ID = "CL-101";
const OTHER_CLIENT_ID = "CL-103";

let contact: { user_id: string; user_type: string; is_agency_admin: boolean };
let otherContact: { user_id: string; user_type: string; is_agency_admin: boolean };
let manager: { user_id: string; user_type: string; is_agency_admin: boolean };

let campaignId = "";
const itemIds: string[] = [];
const requestIds: string[] = [];

async function contactFor(clientId: string) {
  const assignment = await prisma.clientAssignment.findFirstOrThrow({
    where: { client_id: clientId, role_on_client: "client_approver" },
    select: { user_id: true },
  });
  return prisma.user.findUniqueOrThrow({
    where: { user_id: assignment.user_id },
    select: { user_id: true, user_type: true, is_agency_admin: true },
  });
}

async function createItem(status: string, scheduledDate: Date | null, clientId = CLIENT_ID) {
  const campaign =
    clientId === CLIENT_ID
      ? { campaign_id: campaignId }
      : await prisma.campaign.create({
          data: {
            client_id: clientId,
            title: "P8 other client",
            raw_brief_text: "other",
            status: "in_progress",
          },
        });

  const item = await prisma.contentItem.create({
    data: {
      campaign_id: campaign.campaign_id,
      content_form: "post",
      platform: "instagram",
      content_body: "Copy.",
      status,
      scheduled_date: scheduledDate,
    },
  });
  itemIds.push(item.content_item_id);
  return item;
}

async function createRequest(status: string, requestedDate: Date, clientId = CLIENT_ID) {
  const request = await prisma.postRequest.create({
    data: {
      client_id: clientId,
      requested_by_id: clientId === CLIENT_ID ? contact.user_id : otherContact.user_id,
      requested_date: requestedDate,
      status,
    },
  });
  requestIds.push(request.post_request_id);
  return request;
}

beforeAll(async () => {
  contact = await contactFor(CLIENT_ID);
  otherContact = await contactFor(OTHER_CLIENT_ID);

  const client = await prisma.client.findUniqueOrThrow({
    where: { client_id: CLIENT_ID },
    select: { account_manager_id: true },
  });
  manager = await prisma.user.findUniqueOrThrow({
    where: { user_id: client.account_manager_id! },
    select: { user_id: true, user_type: true, is_agency_admin: true },
  });

  const campaign = await prisma.campaign.create({
    data: {
      client_id: CLIENT_ID,
      title: "P8 client calendar",
      raw_brief_text: "P8 test brief",
      status: "in_progress",
    },
  });
  campaignId = campaign.campaign_id;
});

afterEach(async () => {
  await prisma.comment.deleteMany({ where: { post_request_id: { in: requestIds } } });
  await prisma.postRequest.deleteMany({ where: { post_request_id: { in: requestIds } } });
  await prisma.contentItem.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.campaign.deleteMany({
    where: { client_id: OTHER_CLIENT_ID, title: "P8 other client" },
  });
  itemIds.length = 0;
  requestIds.length = 0;
});

afterAll(async () => {
  await prisma.campaign.deleteMany({ where: { campaign_id: campaignId } });
  await prisma.$disconnect();
});

describe("what a client sees on their calendar", () => {
  it("shows posts that are going out, in the month asked for", async () => {
    const item = await createItem("scheduled", new Date("2026-09-15T09:00:00Z"));

    const calendar = await clientCalendar(contact, 2026, 9);

    expect(calendar.posts.map((p) => p.content_item_id)).toContain(item.content_item_id);
  });

  it("does not show approved work with no slot yet", async () => {
    const item = await createItem("client_approved", null);

    const calendar = await clientCalendar(contact, 2026, 9);

    // The account manager's board deliberately does show these -- an approved
    // item nobody scheduled is their problem to notice. A client has no
    // scheduling power, so showing it here would surface a problem they cannot
    // act on.
    expect(calendar.posts.map((p) => p.content_item_id)).not.toContain(item.content_item_id);
  });

  it("does not show another client's posts", async () => {
    const theirs = await createItem("scheduled", new Date("2026-09-15T09:00:00Z"), OTHER_CLIENT_ID);

    const calendar = await clientCalendar(contact, 2026, 9);

    expect(calendar.posts.map((p) => p.content_item_id)).not.toContain(theirs.content_item_id);
  });

  it("shows every one of the client's own requests, not just this month's", async () => {
    // Raised for next quarter, while looking at September. A month filter here
    // would hide it from the only screen offering to withdraw it.
    const future = await createRequest("new", new Date("2027-03-01T00:00:00Z"));

    const calendar = await clientCalendar(contact, 2026, 9);

    expect(calendar.requests.map((r) => r.post_request_id)).toContain(future.post_request_id);
  });

  it("does not show another client's requests", async () => {
    const theirs = await createRequest("new", new Date("2026-09-01T00:00:00Z"), OTHER_CLIENT_ID);

    const calendar = await clientCalendar(contact, 2026, 9);

    expect(calendar.requests.map((r) => r.post_request_id)).not.toContain(theirs.post_request_id);
  });
});

describe("the edit window the screen draws", () => {
  it("marks a new request editable", async () => {
    const request = await createRequest("new", new Date("2026-09-01T00:00:00Z"));

    const calendar = await clientCalendar(contact, 2026, 9);
    const row = calendar.requests.find((r) => r.post_request_id === request.post_request_id);

    expect(row?.client_editable).toBe(true);
  });

  it("closes the window the moment the account manager takes it", async () => {
    const request = await createRequest("under_review", new Date("2026-09-01T00:00:00Z"));

    const calendar = await clientCalendar(contact, 2026, 9);
    const row = calendar.requests.find((r) => r.post_request_id === request.post_request_id);

    // Must match what `updatePostRequest` enforces. A screen offering a control
    // the server refuses is worse than one offering nothing.
    expect(row?.client_editable).toBe(false);
  });

  it("keeps a withdrawn request visible, and not editable", async () => {
    const request = await createRequest("withdrawn", new Date("2026-09-01T00:00:00Z"));

    const calendar = await clientCalendar(contact, 2026, 9);
    const row = calendar.requests.find((r) => r.post_request_id === request.post_request_id);

    // Kept rather than deleted: its thread is part of the client's conversation
    // with their account manager.
    expect(row).toBeDefined();
    expect(row?.client_editable).toBe(false);
  });
});

describe("the account manager's side of the same table", () => {
  it("carries the client's name, which the client's own view has no use for", async () => {
    const request = await createRequest("new", new Date("2026-09-01T00:00:00Z"));

    const incoming = await incomingRequests(manager);
    const row = incoming.find((r) => r.post_request_id === request.post_request_id);

    expect(row?.client_name).toBeTruthy();
    expect(row?.client_id).toBe(CLIENT_ID);
  });

  it("scopes to the clients this manager holds", async () => {
    const theirs = await createRequest("new", new Date("2026-09-01T00:00:00Z"), OTHER_CLIENT_ID);

    const incoming = await incomingRequests(manager);

    // CL-101's manager does not manage CL-103.
    expect(incoming.map((r) => r.post_request_id)).not.toContain(theirs.post_request_id);
  });

  it("openOnly returns just what still needs the manager", async () => {
    await createRequest("new", new Date("2026-09-01T00:00:00Z"));
    const closed = await createRequest("converted", new Date("2026-09-02T00:00:00Z"));

    const incoming = await incomingRequests(manager, { openOnly: true });

    expect(incoming.length).toBeGreaterThan(0);
    expect(incoming.map((r) => r.post_request_id)).not.toContain(closed.post_request_id);
  });
});
