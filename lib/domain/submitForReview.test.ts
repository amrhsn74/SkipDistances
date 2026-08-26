import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../db";
import { submitForReview } from "./submitForReview";

/**
 * The deferred content flag.
 *
 * `queueOrFlag` no longer raises a governance row when the engine declines to
 * draft something -- a refusal a creator reads and abandons is not evidence, and
 * recording it filled the Admin's table with drafts nobody stood behind.
 *
 * Submitting is the act that changes that. These tests assert both halves: that
 * an abandoned refusal leaves nothing behind, and that submitting past one is
 * recorded against the person who chose to.
 */

const SUBMITTER = "TEST-SFR-CREATOR";
const campaignIds: string[] = [];

async function cleanup() {
  await prisma.flag.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  await prisma.contentItem.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  await prisma.campaign.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  await prisma.auditLog.deleteMany({ where: { performed_by_id: SUBMITTER } });
}

beforeEach(async () => {
  await cleanup();
  await prisma.user.upsert({
    where: { user_id: SUBMITTER },
    update: { status: "active" },
    create: {
      user_id: SUBMITTER,
      name: "Test Submitter",
      email: "test-sfr@skipstudio.test",
      user_type: "staff",
    },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { user_id: SUBMITTER } });
  await prisma.$disconnect();
});

async function itemFlaggedOn(clauseCode: string, status = "flagged") {
  const clause = await prisma.guidelineClause.findFirstOrThrow({
    where: { clause_code: clauseCode },
    select: { clause_id: true, source_type: true },
  });

  const campaign = await prisma.campaign.create({
    data: {
      client_id: "CL-101",
      title: `SFR TEST ${Date.now()} ${Math.random()}`,
      raw_brief_text: "brief",
      status: "in_progress",
    },
    select: { campaign_id: true },
  });
  campaignIds.push(campaign.campaign_id);

  const item = await prisma.contentItem.create({
    data: {
      campaign_id: campaign.campaign_id,
      content_form: "post",
      content_body: "20% off all bags this week.",
      status,
      flagged_clause_id: status === "flagged" ? clause.clause_id : null,
    },
    select: { content_item_id: true },
  });

  return { campaignId: campaign.campaign_id, itemId: item.content_item_id, clause };
}

describe("a flagged draft nobody submitted", () => {
  it("leaves no flag for the admin", async () => {
    const { campaignId } = await itemFlaggedOn("CR.4");

    // Drafting and flagging happened; nothing was submitted. The Admin's
    // evidence table stays empty, which is the whole point of the change.
    expect(await prisma.flag.count({ where: { campaign_id: campaignId } })).toBe(0);
  });
});

describe("submitting a flagged draft anyway", () => {
  it("records it against the person who chose to", async () => {
    const { campaignId, itemId, clause } = await itemFlaggedOn("CR.4");

    await submitForReview(itemId, SUBMITTER);

    const flags = await prisma.flag.findMany({ where: { campaign_id: campaignId } });
    expect(flags).toHaveLength(1);

    expect(flags[0]).toMatchObject({
      content_item_id: itemId,
      clause_id: clause.clause_id,
      // Named, unlike an engine-raised content flag -- which is exactly what
      // `openGovernanceFlags` keys on to surface it.
      raised_against_id: SUBMITTER,
      flag_type: "brand_violation",
    });

    const details = JSON.parse(flags[0].details ?? "{}");
    expect(details.submitted_despite_flag).toBe(true);
    expect(details.clause_code).toBe("CR.4");
  });

  it("calls an agency clause a compliance violation, not a brand one", async () => {
    // Only one of the two is negotiable with the client, so the row must say
    // which kind of rule was crossed.
    const { campaignId, itemId } = await itemFlaggedOn("1.3");

    await submitForReview(itemId, SUBMITTER);

    const [row] = await prisma.flag.findMany({ where: { campaign_id: campaignId } });
    expect(row.flag_type).toBe("compliance_violation");
  });

  it("still clears the flag from the item it advanced", async () => {
    const { itemId } = await itemFlaggedOn("CR.4");

    const result = await submitForReview(itemId, SUBMITTER);

    expect(result.status).toBe("pending_internal_review");

    // The flag described the draft that was refused. The row keeps that
    // history; the item moves on without it.
    const row = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: itemId },
    });
    expect(row.flagged_clause_id).toBeNull();
  });
});

describe("submitting a clean draft", () => {
  it("raises nothing", async () => {
    const { campaignId, itemId } = await itemFlaggedOn("CR.4", "drafted");

    await submitForReview(itemId, SUBMITTER);

    expect(await prisma.flag.count({ where: { campaign_id: campaignId } })).toBe(0);
  });
});
