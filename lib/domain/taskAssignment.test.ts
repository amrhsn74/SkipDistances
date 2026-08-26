import { describe, it, expect, beforeEach, afterAll } from "vitest";

import { prisma } from "../db";
import { PermissionDeniedError } from "./permissions";
import {
  ContentItemNotFoundError,
  TaskAssignmentError,
  assignItem,
} from "./taskAssignment";

/**
 * Dispatch, and what it is not.
 *
 * Two properties carry most of the weight here. Assignment must refuse anyone
 * without `task.assign` on that client -- otherwise a creator could hand their
 * own work to someone else -- and it must refuse an assignee who is not a
 * creator *on that client*, because an assignment that grants no access would
 * otherwise surface later as an empty screen rather than here as an error.
 *
 * The third test is the one worth keeping honest over time: assignment must not
 * touch status or approvals. The moment it does, it has become a permission.
 */

const LEAD = "TEST-TA-LEAD";
const CREATOR = "TEST-TA-CREATOR";
const OTHER_CREATOR = "TEST-TA-CREATOR-B";
const OUTSIDER = "TEST-TA-OUTSIDER";
const USERS = [LEAD, CREATOR, OTHER_CREATOR, OUTSIDER];

const CLIENT_A = "CL-101";
const CLIENT_B = "CL-102";

const CAMPAIGN = "TEST-TA-CAMPAIGN";
const ITEM = "TEST-TA-ITEM";

/** The lead is cross-client by role, so it needs no ClientAssignment row. */
const lead = { user_id: LEAD, user_type: "staff", is_agency_admin: false, status: "active" };
const creator = {
  user_id: CREATOR,
  user_type: "staff",
  is_agency_admin: false,
  status: "active",
};

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { performed_by_id: { in: USERS } } });
  await prisma.contentItem.deleteMany({ where: { content_item_id: ITEM } });
  await prisma.campaign.deleteMany({ where: { campaign_id: CAMPAIGN } });
  await prisma.clientAssignment.deleteMany({ where: { user_id: { in: USERS } } });
}

beforeEach(async () => {
  await cleanup();

  for (const id of USERS) {
    await prisma.user.upsert({
      where: { user_id: id },
      update: { status: "active", user_type: "staff", is_agency_admin: false },
      create: {
        user_id: id,
        name: id,
        email: `${id.toLowerCase()}@skipstudio.test`,
        user_type: "staff",
        is_agency_admin: false,
      },
    });
  }

  // The lead is a lead on CLIENT_A; both creators are creators there. The
  // outsider holds nothing anywhere.
  await prisma.clientAssignment.createMany({
    data: [
      { client_id: CLIENT_A, user_id: LEAD, role_on_client: "content_lead" },
      { client_id: CLIENT_A, user_id: CREATOR, role_on_client: "content_creator" },
      { client_id: CLIENT_A, user_id: OTHER_CREATOR, role_on_client: "content_creator" },
    ],
  });

  await prisma.campaign.create({
    data: {
      campaign_id: CAMPAIGN,
      client_id: CLIENT_A,
      title: "Test dispatch campaign",
      raw_brief_text: "Test brief.",
    },
  });

  await prisma.contentItem.create({
    data: {
      content_item_id: ITEM,
      campaign_id: CAMPAIGN,
      content_form: "post",
      content_body: "Draft copy.",
      status: "drafted",
    },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { user_id: { in: USERS } } });
});

describe("assigning", () => {
  it("dispatches an item to a creator and records both ends of the move", async () => {
    const result = await assignItem(lead, ITEM, CREATOR);

    expect(result.previousAssigneeId).toBeNull();
    expect(result.assigneeId).toBe(CREATOR);

    const item = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: ITEM },
    });
    expect(item.assigned_to_id).toBe(CREATOR);

    const [audit] = await prisma.auditLog.findMany({
      where: { entity_id: ITEM, action: "assigned" },
    });
    expect(audit).toBeDefined();
    const details = JSON.parse(audit.details ?? "{}");
    expect(details.from_assignee_id).toBeNull();
    expect(details.to_assignee_id).toBe(CREATOR);
  });

  it("records who lost the work on a reassignment", async () => {
    await assignItem(lead, ITEM, CREATOR);
    const result = await assignItem(lead, ITEM, OTHER_CREATOR);

    expect(result.previousAssigneeId).toBe(CREATOR);
    expect(result.assigneeId).toBe(OTHER_CREATOR);

    const rows = await prisma.auditLog.findMany({
      where: { entity_id: ITEM, action: "assigned" },
      orderBy: { performed_at: "desc" },
    });
    const latest = JSON.parse(rows[0].details ?? "{}");
    expect(latest.from_assignee_id).toBe(CREATOR);
    expect(latest.to_assignee_id).toBe(OTHER_CREATOR);
  });

  it("clears an assignment when passed null", async () => {
    await assignItem(lead, ITEM, CREATOR);
    const result = await assignItem(lead, ITEM, null);

    expect(result.assigneeId).toBeNull();
    const item = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: ITEM },
    });
    expect(item.assigned_to_id).toBeNull();
  });

  it("writes no audit row when the assignee is unchanged", async () => {
    await assignItem(lead, ITEM, CREATOR);
    await assignItem(lead, ITEM, CREATOR);

    const rows = await prisma.auditLog.findMany({
      where: { entity_id: ITEM, action: "assigned" },
    });
    expect(rows).toHaveLength(1);
  });
});

describe("who may dispatch", () => {
  it("refuses a creator: dispatching is the lead's, not theirs", async () => {
    // Asserted on `reason`, not merely on the error type. A refusal for the
    // wrong reason -- scope, say, when the point is the capability -- would
    // otherwise pass and leave the actual rule untested.
    await expect(assignItem(creator, ITEM, OTHER_CREATOR)).rejects.toMatchObject({
      name: "PermissionDeniedError",
      reason: "role_lacks_capability",
      action: "task.assign",
    });

    const item = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: ITEM },
    });
    expect(item.assigned_to_id).toBeNull();
  });

  it("lets a lead dispatch for a client they hold no row on -- the role is cross-client", async () => {
    // `effectiveRole` reads content_lead from *any* ClientAssignment row, then
    // `accessScope` treats that role as unscoped. So a lead assigned only on
    // CLIENT_B still dispatches on CLIENT_A. Worth pinning: it is the one place
    // where holding no row on the client in question is deliberately fine, and
    // a future change that scoped leads per-client would break it here rather
    // than silently in a screen.
    await prisma.clientAssignment.deleteMany({
      where: { user_id: LEAD, client_id: CLIENT_A },
    });
    await prisma.clientAssignment.create({
      data: { client_id: CLIENT_B, user_id: LEAD, role_on_client: "content_lead" },
    });

    await expect(assignItem(lead, ITEM, CREATOR)).resolves.toMatchObject({
      assigneeId: CREATOR,
    });
  });

  it("refuses a user who holds no lead role anywhere", async () => {
    // Same person, no content_lead row at all: `effectiveRole` falls through to
    // account_manager, which does not hold `task.assign`.
    await prisma.clientAssignment.deleteMany({ where: { user_id: LEAD } });

    await expect(assignItem(lead, ITEM, CREATOR)).rejects.toMatchObject({
      name: "PermissionDeniedError",
      reason: "role_lacks_capability",
    });
  });
});

describe("who may be dispatched to", () => {
  it("refuses an assignee who holds no creator role on that client", async () => {
    await expect(assignItem(lead, ITEM, OUTSIDER)).rejects.toThrow(TaskAssignmentError);
  });

  it("refuses a creator assigned to a different client", async () => {
    await prisma.clientAssignment.deleteMany({
      where: { user_id: OTHER_CREATOR, client_id: CLIENT_A },
    });
    await prisma.clientAssignment.create({
      data: { client_id: CLIENT_B, user_id: OTHER_CREATOR, role_on_client: "content_creator" },
    });

    await expect(assignItem(lead, ITEM, OTHER_CREATOR)).rejects.toThrow(TaskAssignmentError);
  });

  it("refuses a lead as an assignee -- dispatch targets creators", async () => {
    await expect(assignItem(lead, ITEM, LEAD)).rejects.toThrow(TaskAssignmentError);
  });
});

describe("what assignment does not do", () => {
  it("leaves status and approvals untouched", async () => {
    await prisma.contentItem.update({
      where: { content_item_id: ITEM },
      data: { status: "internal_approved" },
    });

    await assignItem(lead, ITEM, CREATOR);

    const item = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: ITEM },
    });
    // Who is holding a draft says nothing about whether the draft is any good.
    expect(item.status).toBe("internal_approved");
  });

  it("refuses an unknown item without disclosing whether it exists", async () => {
    await expect(assignItem(lead, "TEST-TA-NOPE", CREATOR)).rejects.toThrow(
      ContentItemNotFoundError,
    );
  });
});
