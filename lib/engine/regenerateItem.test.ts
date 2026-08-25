import { afterEach, describe, expect, it } from "vitest";
import { rm, writeFile } from "node:fs/promises";

import { prisma } from "../db";
import { ok } from "../domain/decision";
import type { GeneratedPlan } from "./generatePlan";
import { searchGuidelines } from "./searchGuidelines";
import { regenerateItem, type RegenerationReference } from "./regenerateItem";

const campaignIds: string[] = [];
const itemIds: string[] = [];
const tempFiles: string[] = [];

afterEach(async () => {
  await prisma.auditLog.deleteMany({ where: { entity_id: { in: [...campaignIds, ...itemIds] } } });
  await prisma.contentItem.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.campaign.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  await Promise.all(tempFiles.splice(0).map((file) => rm(file, { force: true })));
  campaignIds.length = 0;
  itemIds.length = 0;
});

function generatedPlan(over: Partial<GeneratedPlan["items"][number]> = {}): GeneratedPlan {
  return {
    items: [{
      title: "Regenerated morning ritual",
      content_form: "post",
      platform: "instagram",
      content_body: "A newly grounded morning ritual.",
      market_id: null,
      scheduled_date: new Date("2026-02-06"),
      occasion_key: null,
      clause_codes: ["0.1", "CR.1"],
      rationale: "Uses the supplied reference.",
      ...over,
    }],
    notes: null,
  };
}

async function createItem(status = "internal_approved") {
  const campaign = await prisma.campaign.create({
    data: {
      client_id: "CL-102",
      title: "P3.10 regeneration test",
      objective: "test regeneration",
      audience: "coffee drinkers",
      channels: JSON.stringify(["Instagram"]),
      raw_brief_text: "P3.10 test brief",
    },
  });
  campaignIds.push(campaign.campaign_id);
  const item = await prisma.contentItem.create({
    data: {
      campaign_id: campaign.campaign_id,
      content_form: "post",
      platform: "instagram",
      content_body: "Old approved copy.",
      status,
    },
  });
  itemIds.push(item.content_item_id);
  return item;
}

describe("regenerateItem", () => {
  it("passes document references to generation and resets approved content", async () => {
    const item = await createItem();
    const path = `${process.cwd()}/regenerate-reference-${Date.now()}.txt`;
    tempFiles.push(path);
    await writeFile(path, "Use a quiet, ritual-led angle.", "utf8");

    await prisma.referenceAttachment.create({
      data: {
        content_item_id: item.content_item_id,
        file_type: "doc",
        storage_url: path,
        instruction: "Match this angle",
      },
    });

    const captured: { referenceContext?: string } = {};
    const result = await regenerateItem(
      item.content_item_id,
      { prompt: "Make the hook quieter." },
      prisma,
      {
        generate: async (input): Promise<GeneratedPlan> => {
          captured.referenceContext = input.referenceContext;
          return generatedPlan();
        },
        judge: async () => ({ decision: "DRAFT", clause_code: null, flag_type: null, reason: null }),
      },
    );

    expect(captured.referenceContext).toContain("Use a quiet, ritual-led angle.");
    expect(result.status).toBe("drafted");
    expect(result.compliance.outcome).toEqual(ok(result.item));
    const updated = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: item.content_item_id },
      include: { citations: true },
    });
    expect(updated).toMatchObject({ status: "drafted", content_body: "A newly grounded morning ritual." });
    expect(updated.citations).toHaveLength(2);
  });

  it("refuses a reference supplied for another item", async () => {
    const item = await createItem("drafted");
    const reference: RegenerationReference = {
      attachment_id: "other-reference",
      content_item_id: "different-item",
      file_type: "doc",
      storage_url: "unused",
      instruction: null,
    };

    await expect(
      regenerateItem(item.content_item_id, { prompt: "Change it", references: [reference] }, prisma, {
        generate: async () => generatedPlan(),
        judge: async () => ({ decision: "DRAFT", clause_code: null, flag_type: null, reason: null }),
      }),
    ).rejects.toThrow(/different content item/);
  });
});