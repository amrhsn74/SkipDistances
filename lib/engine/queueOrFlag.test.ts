import { afterAll, describe, expect, it } from "vitest";

import { prisma } from "../db";
import { flag, ok, requestInfo } from "../domain/decision";
import type { ItemComplianceResult } from "./complianceCheck";
import type { GeneratedPlanItem } from "./generatePlan";
import { searchGuidelines, type GuidelineBundle } from "./searchGuidelines";
import { QueueOrFlagError, queueOrFlag } from "./queueOrFlag";

/**
 * DB-backed because P3.8 is the persistence boundary. The rows are keyed by
 * campaign ids this file creates, and audit rows are removed by the entity ids
 * returned from the write path.
 */

const campaignIds: string[] = [];
const contentItemIds: string[] = [];
const flagIds: string[] = [];

afterAll(async () => {
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { entity_id: { in: campaignIds } },
        { entity_id: { in: contentItemIds } },
        { entity_id: { in: flagIds } },
      ],
    },
  });
  await prisma.flag.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  await prisma.contentItem.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  await prisma.campaign.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  await prisma.$disconnect();
});

async function createCampaign(clientId: string) {
  const campaign = await prisma.campaign.create({
    data: {
      client_id: clientId,
      title: `P3.8 TEST ${Date.now()} ${Math.random()}`,
      objective: "test persistence",
      audience: "test audience",
      channels: JSON.stringify(["Instagram"]),
      raw_brief_text: "P3.8 queueOrFlag test brief",
      status: "received",
    },
  });
  campaignIds.push(campaign.campaign_id);
  return campaign;
}

function item(over: Partial<GeneratedPlanItem> = {}): GeneratedPlanItem {
  return {
    title: "Morning ritual",
    content_form: "post",
    platform: "instagram",
    content_body: "Meet the roast that makes slow mornings worth it.",
    market_id: null,
    scheduled_date: new Date("2026-02-05"),
    occasion_key: null,
    clause_codes: ["0.1", "CR.1"],
    rationale: "Grounded in the approval flow and Cairo Roast voice.",
    ...over,
  };
}

function draftResult(i = item()): ItemComplianceResult {
  return { item: i, outcome: ok(i), source: "model" };
}

function flagResult(
  i = item({ content_body: "Use ROAST20 for 20% off." }),
): ItemComplianceResult {
  return {
    item: i,
    outcome: flag("CR.4", "brand_violation", "Cairo Roast does not discount."),
    source: "deterministic",
  };
}

async function rememberCreated(result: Awaited<ReturnType<typeof queueOrFlag>>) {
  contentItemIds.push(...result.drafted.map((d) => d.contentItemId));
  contentItemIds.push(...result.flagged.map((f) => f.contentItemId));
}

describe("queueOrFlag", () => {
  it("queues draft outcomes as drafted ContentItems with citations", async () => {
    const campaign = await createCampaign("CL-102");
    const guidelines = await searchGuidelines("CL-102");

    const result = await queueOrFlag({
      campaignId: campaign.campaign_id,
      client: { client_id: "CL-102", industry: "food & beverage" },
      guidelines,
      results: [draftResult()],
    });
    await rememberCreated(result);

    expect(result.campaignStatus).toBe("in_progress");
    expect(result.complianceReviewRequired).toBe(false);
    expect(result.drafted).toHaveLength(1);
    expect(result.flagged).toEqual([]);

    const row = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: result.drafted[0].contentItemId },
      include: { citations: true },
    });
    expect(row).toMatchObject({
      campaign_id: campaign.campaign_id,
      content_form: "post",
      platform: "instagram",
      status: "drafted",
      flagged_clause_id: null,
      grounded_brand_guide_version_id: guidelines.brandGuideVersionId,
    });
    expect(row.citations.map((c) => c.clause_id).sort()).toEqual(
      result.drafted[0].citationClauseIds.sort(),
    );

    const audit = await prisma.auditLog.findMany({
      where: { entity_type: "ContentItem", entity_id: row.content_item_id },
    });
    expect(audit.map((a) => a.action)).toContain("created");
  });

  it("persists flagged outcomes as flagged ContentItems plus Flag rows", async () => {
    const campaign = await createCampaign("CL-102");
    const guidelines = await searchGuidelines("CL-102");
    const cr4 = guidelines.all.find((c) => c.clause_code === "CR.4")!;

    const result = await queueOrFlag({
      campaignId: campaign.campaign_id,
      client: { client_id: "CL-102", industry: "food & beverage" },
      guidelines,
      results: [flagResult()],
    });
    await rememberCreated(result);

    expect(result.flagged).toHaveLength(1);
    expect(result.flagged[0].clauseId).toBe(cr4.clause_id);

    const row = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: result.flagged[0].contentItemId },
    });
    expect(row.status).toBe("flagged");
    expect(row.flagged_clause_id).toBe(cr4.clause_id);

    // The item carries everything needed to explain the refusal...
    expect(result.flagged[0]).toMatchObject({
      clauseCode: "CR.4",
      flagType: "brand_violation",
    });

    // ...but no Flag row exists yet. A refusal the creator reads and abandons is
    // not evidence of anything, and recording it would fill the Admin's table
    // with drafts nobody ever stood behind. `submitForReview` raises the row if
    // and when they submit it anyway.
    const flags = await prisma.flag.findMany({
      where: { content_item_id: row.content_item_id },
    });
    expect(flags).toHaveLength(0);
  });

  it("holds request-info outcomes without inventing a ContentItem or Flag", async () => {
    const campaign = await createCampaign("CL-108");
    const guidelines = await searchGuidelines("CL-108");
    const heldItem = item({
      title: "Best hotel in Egypt",
      content_body: "StayEasy is the best hotel chain in Egypt.",
      clause_codes: ["0.1", "SE.4"],
    });

    const result = await queueOrFlag({
      campaignId: campaign.campaign_id,
      client: { client_id: "CL-108", industry: "hospitality" },
      guidelines,
      results: [
        {
          item: heldItem,
          outcome: requestInfo("1.3", ["the best"], "Supply the award or ranking."),
          source: "deterministic",
        },
      ],
    });
    await rememberCreated(result);

    expect(result.campaignStatus).toBe("info_requested");
    expect(result.requestInfo).toHaveLength(1);
    expect(result.drafted).toEqual([]);
    expect(result.flagged).toEqual([]);

    expect(await prisma.contentItem.count({ where: { campaign_id: campaign.campaign_id } })).toBe(0);
    expect(await prisma.flag.count({ where: { campaign_id: campaign.campaign_id } })).toBe(0);
    expect(
      await prisma.campaign.findUniqueOrThrow({ where: { campaign_id: campaign.campaign_id } }),
    ).toMatchObject({ status: "info_requested" });
  });

  it("marks sensitive-sector campaigns for compliance review even when clean", async () => {
    const campaign = await createCampaign("CL-103");
    const guidelines = await searchGuidelines("CL-103");
    const clean = item({
      title: "Clinic service awareness",
      content_body: "Book a routine checkup with a calm, professional team.",
      clause_codes: ["0.1", "MC.3"],
    });

    const result = await queueOrFlag({
      campaignId: campaign.campaign_id,
      client: { client_id: "CL-103", industry: "healthcare clinics" },
      guidelines,
      results: [draftResult(clean)],
    });
    await rememberCreated(result);

    expect(result.complianceReviewRequired).toBe(true);
    const updated = await prisma.campaign.findUniqueOrThrow({
      where: { campaign_id: campaign.campaign_id },
    });
    expect(updated.compliance_review_required).toBe(true);
  });

  it("rolls back every write if a citation cannot resolve in the scoped bundle", async () => {
    const campaign = await createCampaign("CL-102");
    const guidelines = await searchGuidelines("CL-102");

    await expect(
      queueOrFlag({
        campaignId: campaign.campaign_id,
        client: { client_id: "CL-102", industry: "food & beverage" },
        guidelines,
        results: [draftResult(item({ clause_codes: ["0.1", "NF.1"] }))],
      }),
    ).rejects.toThrow(QueueOrFlagError);

    const updated = await prisma.campaign.findUniqueOrThrow({
      where: { campaign_id: campaign.campaign_id },
    });
    expect(updated.status).toBe("received");
    expect(await prisma.contentItem.count({ where: { campaign_id: campaign.campaign_id } })).toBe(0);
    expect(await prisma.flag.count({ where: { campaign_id: campaign.campaign_id } })).toBe(0);
  });

  it("refuses to queue results onto a campaign for another client", async () => {
    const campaign = await createCampaign("CL-102");

    await expect(
      queueOrFlag({
        campaignId: campaign.campaign_id,
        client: { client_id: "CL-101", industry: "fitness app" },
        guidelines: await searchGuidelines("CL-101"),
        results: [draftResult(item({ clause_codes: ["0.1", "NF.1"] }))],
      }),
    ).rejects.toThrow(/belongs to CL-102/);
  });
});
