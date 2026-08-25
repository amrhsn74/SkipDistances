import { describe, it, expect, afterEach } from "vitest";

import { prisma } from "../db";
import { campaignQueue } from "./campaignQueue";

/**
 * The intake queue, and what it refuses to show.
 *
 * Asserted against the seeded roster: CL-101 and CL-102 are real clients with
 * real account managers, so the scoping is exercised against data that cannot
 * drift from itself.
 */

const createdCampaigns: string[] = [];

afterEach(async () => {
  await prisma.auditLog.deleteMany({ where: { entity_id: { in: createdCampaigns } } });
  await prisma.campaign.deleteMany({ where: { campaign_id: { in: createdCampaigns } } });
  createdCampaigns.length = 0;
});

async function briefFor(clientId: string, title: string) {
  const campaign = await prisma.campaign.create({
    data: {
      client_id: clientId,
      title,
      raw_brief_text: "A brief, for the queue test.",
      status: "received",
    },
  });
  createdCampaigns.push(campaign.campaign_id);
  return campaign;
}

/** Two clients with different account managers, from the seeded roster. */
async function twoManagedClients() {
  const mine = await prisma.client.findFirstOrThrow({
    where: { NOT: { account_manager_id: null } },
    select: { client_id: true, account_manager_id: true },
  });
  const theirs = await prisma.client.findFirstOrThrow({
    where: {
      NOT: [{ account_manager_id: mine.account_manager_id }, { account_manager_id: null }],
    },
    select: { client_id: true, account_manager_id: true },
  });
  return { mine, theirs };
}

async function scopeUser(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { user_id: userId },
    select: { user_id: true, user_type: true, is_agency_admin: true },
  });
  return user;
}

describe("campaignQueue", () => {
  it("lists a manager's own client's briefs", async () => {
    const { mine } = await twoManagedClients();
    const campaign = await briefFor(mine.client_id, "Queue Probe Mine");

    const queue = await campaignQueue(await scopeUser(mine.account_manager_id!));

    expect(queue.map((c) => c.campaign_id)).toContain(campaign.campaign_id);
  });

  /**
   * The isolation guarantee, at the list level. A queue that leaked here would
   * show one client's brief text to another client's team.
   */
  it("never shows another manager's client", async () => {
    const { mine, theirs } = await twoManagedClients();
    const hidden = await briefFor(theirs.client_id, "Queue Probe Theirs");

    const queue = await campaignQueue(await scopeUser(mine.account_manager_id!));

    expect(queue.map((c) => c.campaign_id)).not.toContain(hidden.campaign_id);
  });

  /**
   * The filter is intersected with scope, not substituted for it. Naming
   * somebody else's client must narrow to nothing rather than widen to theirs --
   * that substitution is precisely the bug this asserts against.
   */
  it("cannot be widened by naming a client outside scope", async () => {
    const { mine, theirs } = await twoManagedClients();
    const hidden = await briefFor(theirs.client_id, "Queue Probe Theirs");

    const queue = await campaignQueue(await scopeUser(mine.account_manager_id!), {
      clientId: theirs.client_id,
    });

    expect(queue.map((c) => c.campaign_id)).not.toContain(hidden.campaign_id);
    expect(queue).toHaveLength(0);
  });

  it("narrows to one client inside scope when asked", async () => {
    const { mine } = await twoManagedClients();
    const campaign = await briefFor(mine.client_id, "Queue Probe Mine");

    const queue = await campaignQueue(await scopeUser(mine.account_manager_id!), {
      clientId: mine.client_id,
    });

    expect(queue.every((c) => c.client_id === mine.client_id)).toBe(true);
    expect(queue.map((c) => c.campaign_id)).toContain(campaign.campaign_id);
  });

  it("shows an agency admin every client's brief", async () => {
    const { theirs } = await twoManagedClients();
    const campaign = await briefFor(theirs.client_id, "Queue Probe Theirs");

    const admin = await prisma.user.findFirstOrThrow({
      where: { is_agency_admin: true },
      select: { user_id: true, user_type: true, is_agency_admin: true },
    });

    const queue = await campaignQueue(admin, { limit: 500 });

    expect(queue.map((c) => c.campaign_id)).toContain(campaign.campaign_id);
  });

  it("returns newest first", async () => {
    const { mine } = await twoManagedClients();
    await briefFor(mine.client_id, "Queue Probe Older");
    const newer = await briefFor(mine.client_id, "Queue Probe Newer");

    const queue = await campaignQueue(await scopeUser(mine.account_manager_id!));
    const probes = queue.filter((c) => createdCampaigns.includes(c.campaign_id));

    expect(probes[0].campaign_id).toBe(newer.campaign_id);
  });

  it("carries the client name, so the queue needs no second query", async () => {
    const { mine } = await twoManagedClients();
    await briefFor(mine.client_id, "Queue Probe Mine");

    const queue = await campaignQueue(await scopeUser(mine.account_manager_id!));

    expect(queue[0].client_name).toBeTruthy();
  });
});
