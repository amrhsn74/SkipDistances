import { describe, it, expect, beforeEach, afterAll } from "vitest";

import { prisma } from "@/db";
import { publishItem } from "@/domain/publish";
import { MockPublisher, type PublishRequest, type Publisher } from "@/instagram/client";

/**
 * `P9.4` — the test this whole layer exists to pass.
 *
 * The architecture commits to it plainly: nothing publishes unless both
 * approvals are *still* in place at the moment of publishing, not merely when it
 * was scheduled. So a decline arriving as the scheduler fires must win.
 *
 * The publisher here records every call. That is the assertion: not "the status
 * ended up right", which a lucky ordering could produce, but **the publish call
 * was never made**. A post that reached Instagram and was then marked declined
 * is exactly the failure this design is meant to prevent, and only the call log
 * can tell the two apart.
 *
 * Instagram is mocked, and that changes nothing about what is under test. The
 * gate, the claim, the status machine and the database are all real -- the mock
 * replaces the network and nothing else.
 */

/** A publisher that refuses to be surprised: every call is recorded. */
class RecordingPublisher implements Publisher {
  readonly calls: PublishRequest[] = [];
  private readonly inner = new MockPublisher(0);

  async publish(request: PublishRequest) {
    this.calls.push(request);
    return this.inner.publish(request);
  }

  async remove(platformPostId: string, accessToken: string) {
    return this.inner.remove(platformPostId, accessToken);
  }
}

const CLIENT = "CL-101";
const REVIEWER = "TEST-PR-REVIEWER";
const CONTACT = "TEST-PR-CONTACT";
const USERS = [REVIEWER, CONTACT];

const campaignIds: string[] = [];

async function seedApprovedItem(when: Date) {
  const campaign = await prisma.campaign.create({
    data: { client_id: CLIENT, title: "P9.4 race", raw_brief_text: "race test" },
  });
  campaignIds.push(campaign.campaign_id);

  const item = await prisma.contentItem.create({
    data: {
      campaign_id: campaign.campaign_id,
      content_form: "post",
      platform: "instagram",
      content_body: "Ready to go.",
      status: "scheduled",
      scheduled_date: when,
    },
  });

  // Both stages approved, which is what makes the gate open before the decline.
  await prisma.approval.create({
    data: {
      content_item_id: item.content_item_id,
      stage: "internal",
      decision: "approve",
      decided_by_id: REVIEWER,
    },
  });
  await prisma.approval.create({
    data: {
      content_item_id: item.content_item_id,
      stage: "client",
      decision: "approve",
      decided_by_id: CONTACT,
    },
  });

  return item.content_item_id;
}

beforeEach(async () => {
  await cleanup();

  for (const id of USERS) {
    await prisma.user.upsert({
      where: { user_id: id },
      update: { status: "active" },
      create: {
        user_id: id,
        name: id,
        email: `${id.toLowerCase()}@skipstudio.test`,
        user_type: id === CONTACT ? "client_contact" : "staff",
      },
    });
  }

  await prisma.platformConnection.deleteMany({ where: { client_id: CLIENT } });
  await prisma.platformConnection.create({
    data: {
      client_id: CLIENT,
      platform: "instagram",
      access_token: "test_token",
      platform_account_id: "test_account",
      status: "connected",
    },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.platformConnection.deleteMany({ where: { client_id: CLIENT } });
  await prisma.user.deleteMany({ where: { user_id: { in: USERS } } });
});

async function cleanup() {
  if (campaignIds.length === 0) return;
  const items = await prisma.contentItem.findMany({
    where: { campaign_id: { in: campaignIds } },
    select: { content_item_id: true },
  });
  const itemIds = items.map((i) => i.content_item_id);
  await prisma.metricSnapshot.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.approval.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.auditLog.deleteMany({ where: { entity_id: { in: itemIds } } });
  await prisma.contentItem.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  await prisma.campaign.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  campaignIds.length = 0;
}

describe("the publish-time gate re-check", () => {
  it("never calls Instagram when an approval was withdrawn after scheduling", async () => {
    const due = new Date(Date.now() - 60_000);
    const contentItemId = await seedApprovedItem(due);

    // The withdrawal: a later row for the same stage, which is what the gate
    // reads. The item is still `scheduled` and still due -- exactly the state a
    // scheduler tick would find it in.
    await prisma.approval.create({
      data: {
        content_item_id: contentItemId,
        stage: "client",
        decision: "decline",
        decided_by_id: CONTACT,
        comment: "Withdrawn before it went out.",
      },
    });

    const publisher = new RecordingPublisher();
    const outcome = await publishItem(contentItemId, publisher);

    // The assertion that matters.
    expect(publisher.calls).toHaveLength(0);
    expect(outcome.status).toBe("skipped");

    const item = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: contentItemId },
    });
    expect(item.status).not.toBe("published");
    // And it is off the calendar: a withdrawn item still showing a publish date
    // would read as though it were going out.
    expect(item.scheduled_date).toBeNull();
  });

  it("publishes when both approvals are still current", async () => {
    const contentItemId = await seedApprovedItem(new Date(Date.now() - 60_000));

    const publisher = new RecordingPublisher();
    const outcome = await publishItem(contentItemId, publisher);

    expect(publisher.calls).toHaveLength(1);
    expect(outcome.status).toBe("published");

    const item = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: contentItemId },
    });
    expect(item.status).toBe("published");
  });

  it("lets exactly one of two concurrent ticks publish", async () => {
    const contentItemId = await seedApprovedItem(new Date(Date.now() - 60_000));

    const publisher = new RecordingPublisher();

    // Two ticks racing over the same item -- the case the conditional claim
    // exists for. A check-then-act would let both read `scheduled` and both go.
    const [first, second] = await Promise.all([
      publishItem(contentItemId, publisher),
      publishItem(contentItemId, publisher),
    ]);

    expect(publisher.calls).toHaveLength(1);

    const outcomes = [first.status, second.status].sort();
    expect(outcomes).toEqual(["published", "skipped"]);
  });

  it("does not publish something that is not yet due", async () => {
    const contentItemId = await seedApprovedItem(new Date(Date.now() + 3_600_000));

    const publisher = new RecordingPublisher();
    const outcome = await publishItem(contentItemId, publisher);

    expect(publisher.calls).toHaveLength(0);
    expect(outcome.status).toBe("skipped");
  });

  it("marks a failed publish rather than silently returning it to the queue", async () => {
    const contentItemId = await seedApprovedItem(new Date(Date.now() - 60_000));

    const failing: Publisher = {
      publish: async () => {
        throw new Error("Instagram said no.");
      },
      remove: async () => {},
    };

    const outcome = await publishItem(contentItemId, failing);

    expect(outcome.status).toBe("failed");

    const item = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: contentItemId },
    });
    // Not back to `scheduled`: that would retry forever and tell nobody.
    expect(item.status).toBe("publish_failed");
  });
});
