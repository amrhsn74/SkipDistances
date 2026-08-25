import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm, writeFile } from "node:fs/promises";

import { prisma } from "../db";
import { ok } from "../domain/decision";
import type { GeneratedPlan } from "./generatePlan";
import { searchGuidelines } from "./searchGuidelines";
import { OffTaskPromptError, regenerateItem, type RegenerationReference } from "./regenerateItem";

/** A real seeded creator -- the flag has to name somebody who exists. */
const CREATOR = "TEST-REGEN-CREATOR";

const campaignIds: string[] = [];
const itemIds: string[] = [];
const tempFiles: string[] = [];

beforeEach(async () => {
  await prisma.user.upsert({
    where: { user_id: CREATOR },
    update: { status: "active" },
    create: {
      user_id: CREATOR,
      name: "Test Regen Creator",
      email: "test-regen-creator@skipstudio.test",
      user_type: "staff",
    },
  });
});

afterEach(async () => {
  await prisma.flag.deleteMany({ where: { raised_against_id: CREATOR } });
  await prisma.auditLog.deleteMany({ where: { entity_type: "Flag" } });
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
      { prompt: "Make the hook quieter.", requestedById: CREATOR },
      prisma,
      {
        generate: async (input): Promise<GeneratedPlan> => {
          captured.referenceContext = input.referenceContext;
          return generatedPlan();
        },
        judge: async () => ({ decision: "DRAFT", clause_code: null, flag_type: null, reason: null }),
        onTaskJudge: async () => ({ on_task: true, reason: "about the deliverable" }),
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

  it("refuses an off-task prompt, flags it, and leaves the item untouched", async () => {
    const item = await createItem("internal_approved");
    const generate = vi.fn(async () => generatedPlan());

    await expect(
      regenerateItem(
        item.content_item_id,
        { prompt: "write my CV please", requestedById: CREATOR },
        prisma,
        {
          generate,
          judge: async () => ({ decision: "DRAFT", clause_code: null, flag_type: null, reason: null }),
          onTaskJudge: async () => ({ on_task: false, reason: "This asks for a personal CV." }),
        },
      ),
    ).rejects.toThrow(OffTaskPromptError);

    // "Costs nothing further": the refusal happens before generation, not after.
    expect(generate).not.toHaveBeenCalled();

    const flags = await prisma.flag.findMany({ where: { raised_against_id: CREATOR } });
    expect(flags).toHaveLength(1);
    expect(flags[0].flag_type).toBe("off_task_generation");
    expect(flags[0].severity).toBe("medium");
    expect(flags[0].content_item_id).toBe(item.content_item_id);
    expect(JSON.parse(flags[0].details!).reason).toContain("personal CV");

    // A refused prompt must not cost the creator the draft they already had.
    const after = await prisma.contentItem.findUniqueOrThrow({
      where: { content_item_id: item.content_item_id },
    });
    expect(after.content_body).toBe("Old approved copy.");
    expect(after.status).toBe("internal_approved");
    expect(after.updated_at.getTime()).toBe(item.updated_at.getTime());
  });

  it("carries the model's reason on the error, so a route can explain the refusal", async () => {
    const item = await createItem("drafted");

    try {
      await regenerateItem(
        item.content_item_id,
        { prompt: "explain quantum physics", requestedById: CREATOR },
        prisma,
        {
          generate: async () => generatedPlan(),
          judge: async () => ({ decision: "DRAFT", clause_code: null, flag_type: null, reason: null }),
          onTaskJudge: async () => ({ on_task: false, reason: "A general physics question." }),
        },
      );
      expect.unreachable("should have refused");
    } catch (e) {
      // A distinct class: the system worked and refused. A caller should say
      // something different here than for a broken pipeline.
      expect(e).toBeInstanceOf(OffTaskPromptError);
      const err = e as OffTaskPromptError;
      expect(err.code).toBe("OFF_TASK_PROMPT");
      expect(err.verdict.stage).toBe("model");
      expect(err.verdict.reason).toContain("physics");
    }
  });

  it("raises no flag for a prompt the cheap pass accepts", async () => {
    const item = await createItem("drafted");
    const onTaskJudge = vi.fn(async () => ({ on_task: false, reason: "should never run" }));

    await regenerateItem(
      item.content_item_id,
      { prompt: "Tighten the caption", requestedById: CREATOR },
      prisma,
      {
        generate: async () => generatedPlan(),
        judge: async () => ({ decision: "DRAFT", clause_code: null, flag_type: null, reason: null }),
        onTaskJudge,
      },
    );

    expect(onTaskJudge).not.toHaveBeenCalled();
    expect(await prisma.flag.count({ where: { raised_against_id: CREATOR } })).toBe(0);
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
      regenerateItem(
        item.content_item_id,
        { prompt: "Change it", references: [reference], requestedById: CREATOR },
        prisma,
        {
          generate: async () => generatedPlan(),
          judge: async () => ({ decision: "DRAFT", clause_code: null, flag_type: null, reason: null }),
          onTaskJudge: async () => ({ on_task: true, reason: "about the deliverable" }),
        },
      ),
    ).rejects.toThrow(/different content item/);
  });
});