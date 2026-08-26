import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";

import { prisma } from "../db";
import { regenerationHistory } from "./regenerationHistory";

/**
 * "Which reference produced which draft" -- visible, not just claimed.
 *
 * The ERD's stated reason for accumulating `ReferenceAttachment` rows rather
 * than overwriting them. What is tested here is that the pairing actually holds:
 * a run reports the references it was prompted with, a hand edit is not mistaken
 * for a regeneration, and the references from a *refused* run are surfaced
 * rather than silently dropped -- which is the case a naive join loses, because
 * a refusal writes no edit row for those attachments to hang off.
 */

const CREATOR_EMAIL = "mona.farid@skipstudio.test";
const OTHER_CREATOR_EMAIL = "nour.kamal@skipstudio.test";

let creator: { user_id: string; user_type: string; is_agency_admin: boolean };
let otherCreator: { user_id: string; user_type: string; is_agency_admin: boolean };

let campaignId = "";
const itemIds: string[] = [];

async function createItem() {
  const item = await prisma.contentItem.create({
    data: {
      campaign_id: campaignId,
      content_form: "post",
      platform: "instagram",
      content_body: "Draft copy.",
      status: "drafted",
    },
  });
  itemIds.push(item.content_item_id);
  return item;
}

async function attach(contentItemId: string, instruction: string) {
  return prisma.referenceAttachment.create({
    data: {
      content_item_id: contentItemId,
      uploaded_by_id: creator.user_id,
      file_type: "image",
      // An absolute-looking disk path, as `storeReferences` writes. The public
      // URL is derived from the basename, which is what this asserts on.
      storage_url: `/srv/uploads/references/${contentItemId}-${instruction}.jpg`,
      instruction,
    },
  });
}

/** The audit row `regenerateItem` writes when a regeneration succeeds. */
async function recordRun(contentItemId: string, referenceIds: string[]) {
  return prisma.auditLog.create({
    data: {
      entity_type: "ContentItem",
      entity_id: contentItemId,
      action: "edited",
      performed_by_id: creator.user_id,
      details: JSON.stringify({
        from_status: "drafted",
        to_status: "drafted",
        reference_ids: referenceIds,
      }),
    },
  });
}

beforeAll(async () => {
  creator = await prisma.user.findUniqueOrThrow({
    where: { email: CREATOR_EMAIL },
    select: { user_id: true, user_type: true, is_agency_admin: true },
  });
  otherCreator = await prisma.user.findUniqueOrThrow({
    where: { email: OTHER_CREATOR_EMAIL },
    select: { user_id: true, user_type: true, is_agency_admin: true },
  });

  const campaign = await prisma.campaign.create({
    data: {
      client_id: "CL-101",
      title: "P7.4 regeneration history",
      objective: "test the history read",
      audience: "test",
      channels: JSON.stringify(["Instagram"]),
      raw_brief_text: "P7.4 test brief",
    },
  });
  campaignId = campaign.campaign_id;
});

afterEach(async () => {
  await prisma.auditLog.deleteMany({ where: { entity_id: { in: itemIds } } });
  await prisma.referenceAttachment.deleteMany({
    where: { content_item_id: { in: itemIds } },
  });
  await prisma.contentItem.deleteMany({ where: { content_item_id: { in: itemIds } } });
  itemIds.length = 0;
});

afterAll(async () => {
  await prisma.campaign.deleteMany({ where: { campaign_id: campaignId } });
  await prisma.$disconnect();
});

describe("pairing references to runs", () => {
  it("reports the references a run was prompted with", async () => {
    const item = await createItem();
    const reference = await attach(item.content_item_id, "match-this-angle");
    await recordRun(item.content_item_id, [reference.attachment_id]);

    const history = await regenerationHistory(creator, item.content_item_id);

    expect(history.runs).toHaveLength(1);
    expect(history.runs[0].references.map((r) => r.instruction)).toEqual([
      "match-this-angle",
    ]);
    expect(history.unattributed).toEqual([]);
  });

  it("keeps runs separate, so a later reference is not credited to an earlier draft", async () => {
    const item = await createItem();
    const first = await attach(item.content_item_id, "first");
    await recordRun(item.content_item_id, [first.attachment_id]);
    const second = await attach(item.content_item_id, "second");
    await recordRun(item.content_item_id, [second.attachment_id]);

    const history = await regenerationHistory(creator, item.content_item_id);

    // Newest first, and each run carries only its own. This is the whole claim:
    // which reference produced which version, not which files exist.
    expect(history.runs).toHaveLength(2);
    expect(history.runs[0].references.map((r) => r.instruction)).toEqual(["second"]);
    expect(history.runs[1].references.map((r) => r.instruction)).toEqual(["first"]);
  });

  it("does not mistake a hand edit for a regeneration", async () => {
    const item = await createItem();
    await prisma.auditLog.create({
      data: {
        entity_type: "ContentItem",
        entity_id: item.content_item_id,
        action: "edited",
        performed_by_id: creator.user_id,
        // No `reference_ids` key at all -- what `editDraft` and
        // `submitForReview` write.
        details: JSON.stringify({ from_status: "drafted", to_status: "drafted" }),
      },
    });

    const history = await regenerationHistory(creator, item.content_item_id);

    expect(history.runs).toEqual([]);
  });

  it("reports a prompt-only regeneration as a run with no references", async () => {
    const item = await createItem();
    await recordRun(item.content_item_id, []);

    const history = await regenerationHistory(creator, item.content_item_id);

    expect(history.runs).toHaveLength(1);
    expect(history.runs[0].references).toEqual([]);
  });
});

describe("references from a refused run", () => {
  it("surfaces attachments no run claims rather than dropping them", async () => {
    const item = await createItem();
    const used = await attach(item.content_item_id, "used");
    await recordRun(item.content_item_id, [used.attachment_id]);
    // Stored, then the regeneration was refused -- so no edit row names it.
    const refused = await attach(item.content_item_id, "produced-a-flag");

    const history = await regenerationHistory(creator, item.content_item_id);

    // The case a naive join loses. A reference that produced a flagged result is
    // exactly the one a reviewer wants to look at, so it must not vanish for
    // want of an audit row to hang off.
    expect(history.runs[0].references.map((r) => r.instruction)).toEqual(["used"]);
    expect(history.unattributed.map((r) => r.instruction)).toEqual(["produced-a-flag"]);
  });
});

describe("what a reference row carries", () => {
  it("derives a browser path from the stored disk path", async () => {
    const item = await createItem();
    const reference = await attach(item.content_item_id, "angle");
    await recordRun(item.content_item_id, [reference.attachment_id]);

    const history = await regenerationHistory(creator, item.content_item_id);

    // `storage_url` is an absolute disk path -- `regenerateItem` reads bytes
    // from it rather than serving it. The panel needs something a browser can
    // fetch.
    expect(history.runs[0].references[0].public_url).toBe(
      `/uploads/references/${item.content_item_id}-angle.jpg`,
    );
    expect(history.runs[0].references[0].uploaded_by_name).toBeTruthy();
  });
});

describe("scope", () => {
  it("returns an empty history for an item outside the reader's scope", async () => {
    const item = await createItem();
    const reference = await attach(item.content_item_id, "theirs");
    await recordRun(item.content_item_id, [reference.attachment_id]);

    // Nour is not assigned to CL-101. Empty, never someone else's references.
    const history = await regenerationHistory(otherCreator, item.content_item_id);

    expect(history).toEqual({ runs: [], unattributed: [] });
  });
});
