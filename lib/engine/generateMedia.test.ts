import { afterAll, describe, expect, it, vi } from "vitest";

import { prisma } from "../db";
import { ImageGenerationError } from "../llm/gemini";
import type { GeneratedPlanItem } from "./generatePlan";
import type { PersistedDraft } from "./queueOrFlag";
import { generateMedia, toImagePrompt, visualDrafts } from "./generateMedia";

/**
 * The image model is stubbed throughout: what is under test is the sequencing
 * and the failure handling, neither of which needs a real picture. The DB is
 * real, because writing the `MediaAsset` row is the half of this that was
 * missing.
 */

const campaignIds: string[] = [];
const contentItemIds: string[] = [];

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { entity_id: { in: contentItemIds } } });
  await prisma.mediaAsset.deleteMany({
    where: { content_item_id: { in: contentItemIds } },
  });
  await prisma.contentItem.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  await prisma.campaign.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  await prisma.$disconnect();
});

const CLIENT = { name: "Cairo Roast", industry: "coffee" };

function planItem(overrides: Partial<GeneratedPlanItem> = {}): GeneratedPlanItem {
  return {
    title: "Autumn blend hero shot",
    content_form: "image",
    platform: "instagram",
    content_body: "A warm flat-lay of the new autumn blend beside a ceramic cup.",
    market_id: null,
    scheduled_date: null,
    occasion_key: null,
    clause_codes: ["1.1"],
    rationale: "Warm, earthy palette per the brand guide.",
    ...overrides,
  };
}

async function persistedDraft(
  overrides: Partial<GeneratedPlanItem> = {},
): Promise<PersistedDraft> {
  const client = await prisma.client.findFirstOrThrow({ select: { client_id: true } });
  const campaign = await prisma.campaign.create({
    data: {
      client_id: client.client_id,
      title: `MEDIA TEST ${Date.now()} ${Math.random()}`,
      objective: "test media",
      audience: "test audience",
      channels: JSON.stringify(["Instagram"]),
      raw_brief_text: "generateMedia test brief",
      status: "in_progress",
    },
    select: { campaign_id: true },
  });
  campaignIds.push(campaign.campaign_id);

  const item = planItem(overrides);
  const row = await prisma.contentItem.create({
    data: {
      campaign_id: campaign.campaign_id,
      content_form: item.content_form,
      platform: item.platform,
      content_body: item.content_body,
      status: "drafted",
    },
    select: { content_item_id: true },
  });
  contentItemIds.push(row.content_item_id);

  return { contentItemId: row.content_item_id, item, citationClauseIds: [] };
}

/** A 1x1 PNG, so the bytes written to disk are a real image. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const stubImage = () =>
  vi.fn().mockResolvedValue({
    bytes: PIXEL,
    mimeType: "image/png",
    enhancedPrompt: null,
  });

describe("visualDrafts", () => {
  it("selects only the forms whose content is a picture", () => {
    const drafts = [
      { contentItemId: "a", item: planItem({ content_form: "image" }), citationClauseIds: [] },
      { contentItemId: "b", item: planItem({ content_form: "post" }), citationClauseIds: [] },
      { contentItemId: "c", item: planItem({ content_form: "reel" }), citationClauseIds: [] },
      { contentItemId: "d", item: planItem({ content_form: "blog_post" }), citationClauseIds: [] },
    ];

    expect(visualDrafts(drafts).map((d) => d.contentItemId)).toEqual(["a", "c"]);
  });
});

describe("toImagePrompt", () => {
  it("anchors the prompt to the client, the copy and the direction", () => {
    const draft = {
      contentItemId: "x",
      item: planItem(),
      citationClauseIds: [],
    };
    const prompt = toImagePrompt(draft, CLIENT);

    expect(prompt).toContain("Cairo Roast");
    expect(prompt).toContain("coffee");
    expect(prompt).toContain("warm flat-lay");
    expect(prompt).toContain("Warm, earthy palette");
  });

  it("forbids rendered text, which the caption already carries", () => {
    const prompt = toImagePrompt(
      { contentItemId: "x", item: planItem(), citationClauseIds: [] },
      CLIENT,
    );
    expect(prompt).toMatch(/Do not render any text/i);
  });

  it("falls back to the title when the item has no body", () => {
    const prompt = toImagePrompt(
      {
        contentItemId: "x",
        item: planItem({ content_body: null }),
        citationClauseIds: [],
      },
      CLIENT,
    );
    expect(prompt).toContain("Autumn blend hero shot");
  });
});

describe("generateMedia", () => {
  it("attaches a MediaAsset to a visual draft", async () => {
    const draft = await persistedDraft();
    const generate = stubImage();

    const result = await generateMedia(
      { client: CLIENT, drafted: [draft] },
      prisma,
      generate,
    );

    expect(result.attempted).toBe(1);
    expect(result.outcomes[0].status).toBe("generated");

    const assets = await prisma.mediaAsset.findMany({
      where: { content_item_id: draft.contentItemId },
    });
    expect(assets).toHaveLength(1);
    expect(assets[0].generation_source).toBe("ai_generated");
    // A public path, not an absolute one -- this goes straight into src=.
    expect(assets[0].storage_url).toMatch(/^\/uploads\/media\//);
  });

  it("spends nothing on a non-visual draft", async () => {
    const draft = await persistedDraft({ content_form: "post" });
    const generate = stubImage();

    const result = await generateMedia(
      { client: CLIENT, drafted: [draft] },
      prisma,
      generate,
    );

    expect(result.attempted).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it("uses the aspect ratio the form is cut to", async () => {
    const draft = await persistedDraft({ content_form: "reel" });
    const generate = stubImage();

    await generateMedia({ client: CLIENT, drafted: [draft] }, prisma, generate);

    expect(generate.mock.calls[0][1]).toMatchObject({ aspectRatio: "9:16" });
  });

  it("reports a safety decline as declined, not failed", async () => {
    const draft = await persistedDraft();
    const generate = vi
      .fn()
      .mockRejectedValue(new ImageGenerationError("declined", "unsafe prompt"));

    const result = await generateMedia(
      { client: CLIENT, drafted: [draft] },
      prisma,
      generate,
    );

    expect(result.outcomes[0].status).toBe("declined");
  });

  it("survives a generation fault without throwing", async () => {
    const draft = await persistedDraft();
    const generate = vi.fn().mockRejectedValue(new Error("connection reset"));

    const result = await generateMedia(
      { client: CLIENT, drafted: [draft] },
      prisma,
      generate,
    );

    expect(result.outcomes[0].status).toBe("failed");
    // The point of the whole try/catch: the campaign's text is untouched.
    const item = await prisma.contentItem.findUnique({
      where: { content_item_id: draft.contentItemId },
      select: { status: true },
    });
    expect(item?.status).toBe("drafted");
  });

  it("keeps generating after one item fails", async () => {
    const bad = await persistedDraft();
    const good = await persistedDraft();

    const generate = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue({ bytes: PIXEL, mimeType: "image/png", enhancedPrompt: null });

    const result = await generateMedia(
      { client: CLIENT, drafted: [bad, good] },
      prisma,
      generate,
    );

    expect(result.outcomes.map((o) => o.status)).toEqual(["failed", "generated"]);
  });
});
