import { describe, it, expect, afterEach } from "vitest";

import { prisma } from "../db";
import { recordDecision } from "./approvals";
import {
  GateClosedError,
  SchedulingError,
  instantForZone,
  scheduleItem,
  unscheduleItem,
} from "./scheduling";

/**
 * Booking an exact publish slot.
 *
 * The gate rules themselves live in `gate.test.ts`; what is tested here is what
 * scheduling adds -- that a closed gate refuses, that a past time refuses, and
 * that a wall-clock time in a market's zone becomes the right instant.
 */

const createdCampaigns: string[] = [];
const createdItems: string[] = [];

afterEach(async () => {
  await prisma.auditLog.deleteMany({
    where: { entity_id: { in: [...createdItems, ...createdCampaigns] } },
  });
  await prisma.approval.deleteMany({ where: { content_item_id: { in: createdItems } } });
  await prisma.contentItem.deleteMany({ where: { content_item_id: { in: createdItems } } });
  await prisma.campaign.deleteMany({ where: { campaign_id: { in: createdCampaigns } } });
  createdItems.length = 0;
  createdCampaigns.length = 0;
});

/** An item on the seeded roster, at whatever status the test needs. */
async function anItem(status: string) {
  const campaign = await prisma.campaign.create({
    data: {
      client_id: "CL-101",
      title: "Scheduling probe",
      raw_brief_text: "A brief, for the scheduling test.",
      status: "complete",
    },
  });
  createdCampaigns.push(campaign.campaign_id);

  const item = await prisma.contentItem.create({
    data: {
      campaign_id: campaign.campaign_id,
      content_form: "post",
      content_body: "Draft body.",
      status,
    },
  });
  createdItems.push(item.content_item_id);
  return item;
}

/** Any real staff user -- the audit row has to name somebody who exists. */
async function anActor() {
  const user = await prisma.user.findFirstOrThrow({
    where: { user_type: "staff", status: "active" },
    select: { user_id: true },
  });
  return user.user_id;
}

/**
 * Walk an item through both approval stages, so the gate is open.
 *
 * The item is moved to `pending_client_review` between the two. That is a real
 * step in the workflow rather than a detail of the test: an internally approved
 * item is not yet in front of the client, and the status machine refuses to jump
 * straight from `internal_approved` to `client_approved`.
 */
async function approveBothStages(contentItemId: string, actorId: string) {
  await recordDecision(contentItemId, {
    stage: "internal",
    decision: "approve",
    comment: null,
    decidedById: actorId,
    bulkActionId: null,
  });

  await prisma.contentItem.update({
    where: { content_item_id: contentItemId },
    data: { status: "pending_client_review" },
  });

  await recordDecision(contentItemId, {
    stage: "client",
    decision: "approve",
    comment: null,
    decidedById: actorId,
    bulkActionId: null,
  });
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

describe("scheduleItem", () => {
  it("books a slot once both stages are approved", async () => {
    const actor = await anActor();
    const item = await anItem("pending_internal_review");
    await approveBothStages(item.content_item_id, actor);

    const when = inDays(3);
    const result = await scheduleItem(
      { contentItemId: item.content_item_id, publishAt: when },
      actor,
    );

    expect(result.status).toBe("scheduled");
    expect(result.scheduledFor.toISOString()).toBe(when);

    const row = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: item.content_item_id },
    });
    // The exact instant is kept, not the day. A date-only column would round
    // 19:00 away and there would be nothing left to publish *at*.
    expect(row.scheduled_date?.toISOString()).toBe(when);
    expect(row.status).toBe("scheduled");
  });

  /**
   * The guarantee the whole product is built around: nothing is scheduled
   * without both approvals currently recorded.
   */
  it("refuses when neither stage has approved", async () => {
    const actor = await anActor();
    const item = await anItem("drafted");

    await expect(
      scheduleItem({ contentItemId: item.content_item_id, publishAt: inDays(3) }, actor),
    ).rejects.toBeInstanceOf(GateClosedError);
  });

  it("refuses when only the internal stage has approved", async () => {
    const actor = await anActor();
    const item = await anItem("pending_internal_review");
    await recordDecision(item.content_item_id, {
      stage: "internal",
      decision: "approve",
      comment: null,
      decidedById: actor,
      bulkActionId: null,
    });

    const error = await scheduleItem(
      { contentItemId: item.content_item_id, publishAt: inDays(3) },
      actor,
    ).catch((e) => e);

    expect(error).toBeInstanceOf(GateClosedError);
    // Naming the missing stage is what lets the screen say "waiting on the
    // client" rather than a bare refusal.
    expect(error.blockedBy).toEqual(["client"]);
  });

  it("refuses a time in the past", async () => {
    const actor = await anActor();
    const item = await anItem("pending_internal_review");
    await approveBothStages(item.content_item_id, actor);

    await expect(
      scheduleItem({ contentItemId: item.content_item_id, publishAt: inDays(-1) }, actor),
    ).rejects.toBeInstanceOf(SchedulingError);
  });

  /**
   * An instant with no offset is ambiguous between two markets an hour apart.
   * Guessing the zone here is how a post goes out at the wrong hour with
   * nothing in the record to explain it.
   */
  it("refuses a time with no timezone offset", async () => {
    const actor = await anActor();
    const item = await anItem("pending_internal_review");
    await approveBothStages(item.content_item_id, actor);

    await expect(
      scheduleItem(
        { contentItemId: item.content_item_id, publishAt: "2026-09-01T19:00" },
        actor,
      ),
    ).rejects.toMatchObject({ issues: { publishAt: expect.any(String) } });
  });

  it("refuses an unknown item", async () => {
    const actor = await anActor();
    await expect(
      scheduleItem({ contentItemId: "no-such-item", publishAt: inDays(3) }, actor),
    ).rejects.toBeInstanceOf(SchedulingError);
  });

  it("writes an audit row naming the instant", async () => {
    const actor = await anActor();
    const item = await anItem("pending_internal_review");
    await approveBothStages(item.content_item_id, actor);

    const when = inDays(5);
    await scheduleItem({ contentItemId: item.content_item_id, publishAt: when }, actor);

    const audit = await prisma.auditLog.findFirst({
      where: { entity_id: item.content_item_id, action: "scheduled" },
    });
    expect(audit).not.toBeNull();
    expect(String(audit?.details)).toContain(when);
  });
});

describe("unscheduleItem", () => {
  /**
   * The reason this is not a decline. Moving a post off a bad date must not
   * cost the client's approval -- otherwise every date change becomes a
   * re-approval round trip.
   */
  it("releases the slot and keeps both approvals", async () => {
    const actor = await anActor();
    const item = await anItem("pending_internal_review");
    await approveBothStages(item.content_item_id, actor);
    await scheduleItem({ contentItemId: item.content_item_id, publishAt: inDays(3) }, actor);

    const result = await unscheduleItem(item.content_item_id, actor);

    expect(result.status).toBe("client_approved");

    const row = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: item.content_item_id },
    });
    expect(row.scheduled_date).toBeNull();

    // Both approval rows survive, which is the whole point.
    const approvals = await prisma.approval.findMany({
      where: { content_item_id: item.content_item_id },
    });
    expect(approvals.filter((a) => a.decision === "approve")).toHaveLength(2);
  });

  it("refuses an item that is not scheduled", async () => {
    const actor = await anActor();
    const item = await anItem("drafted");

    await expect(unscheduleItem(item.content_item_id, actor)).rejects.toBeInstanceOf(
      SchedulingError,
    );
  });
});

describe("instantForZone", () => {
  /**
   * The conversion the calendar depends on. Egypt and Saudi are an hour apart,
   * so the same wall-clock time is two different instants -- which is exactly
   * why the market's zone is stored rather than assumed.
   */
  it("reads a wall-clock time in the market's zone", () => {
    // 1 September 2026, 19:00. Cairo is UTC+3 in summer (Egypt reintroduced
    // DST in 2023), Riyadh is UTC+3 year round.
    const cairo = instantForZone("2026-09-01T19:00", "Africa/Cairo");
    const riyadh = instantForZone("2026-09-01T19:00", "Asia/Riyadh");

    // Whatever the offsets are, each must round-trip back to 19:00 local.
    expect(localHour(cairo, "Africa/Cairo")).toBe(19);
    expect(localHour(riyadh, "Asia/Riyadh")).toBe(19);
  });

  it("produces a real UTC instant, not a local-time string", () => {
    const instant = instantForZone("2026-01-15T09:30", "Asia/Riyadh");
    // Riyadh is UTC+3 with no DST, so 09:30 local is 06:30Z.
    expect(instant.toISOString()).toBe("2026-01-15T06:30:00.000Z");
  });

  /**
   * Winter and summer, so a hardcoded offset table would fail one of them.
   * `Intl` reads the platform's timezone database instead.
   */
  it("handles both sides of a daylight-saving boundary", () => {
    const winter = instantForZone("2026-01-15T12:00", "Africa/Cairo");
    const summer = instantForZone("2026-07-15T12:00", "Africa/Cairo");

    expect(localHour(winter, "Africa/Cairo")).toBe(12);
    expect(localHour(summer, "Africa/Cairo")).toBe(12);
  });

  it("refuses a malformed local time", () => {
    expect(() => instantForZone("tomorrow evening", "Africa/Cairo")).toThrow(SchedulingError);
  });
});

/** The hour a given instant reads as, in a given zone. */
function localHour(at: Date, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      hour: "2-digit",
    }).format(at),
  ) % 24;
}
