import { describe, it, expect } from "vitest";

import { prisma } from "../db";
import { TEMPERATURE } from "../llm/gemini";
import { isOk } from "../domain/decision";
import { resolveClient } from "../domain/clientResolution";
import type { BriefAnalysis } from "./analyzeBrief";
import { resolveCalendar } from "./resolveCalendar";
import { searchGuidelines } from "./searchGuidelines";
import {
  InvalidGeneratedPlanError,
  type GeneratePlanInput,
  type StructuredGenerator,
  buildGeneratePlanPrompt,
  generatePlan,
} from "./generatePlan";

/**
 * The Gemini call is injected, so this file runs with no key and no network.
 * These tests are about the guarantees around the call: the prompt contains
 * only scoped context, and the returned market/citation fields are validated
 * against the database and retrieved guideline bundle rather than trusted.
 */

function analysis(over: Partial<BriefAnalysis> = {}): BriefAnalysis {
  return {
    client_reference: "CL-102",
    client_id: "CL-102",
    title: "Cairo Roast ritual reels",
    objective: "drive morning footfall with story-led coffee content.",
    audience: "young professionals in Cairo.",
    channels: ["Instagram"],
    deliverables: [
      { kind: "post", quantity: 1, raw: "one caption" },
      { kind: "reel", quantity: 1, raw: "one reel concept" },
    ],
    notes: null,
    date: "2026-02-01",
    explicitly_missing: [],
    ...over,
  };
}

async function inputFor(clientId = "CL-102"): Promise<GeneratePlanInput> {
  const clientOutcome = await resolveClient(clientId);
  if (!isOk(clientOutcome)) throw new Error(`expected ${clientId} to resolve`);

  const window = { from: new Date("2026-02-01"), to: new Date("2026-03-15") };
  return {
    client: clientOutcome.value,
    analysis: analysis({ client_reference: clientId, client_id: clientId }),
    calendar: await resolveCalendar(clientId, window),
    guidelines: await searchGuidelines(clientId),
  };
}

async function marketId(countryCode: string): Promise<string> {
  const market = await prisma.market.findUniqueOrThrow({
    where: { country_code: countryCode },
    select: { market_id: true },
  });
  return market.market_id;
}

function rawPlan(over: Record<string, unknown> = {}) {
  return {
    items: [
      {
        title: "Morning ritual post",
        content_form: "post",
        platform: "instagram",
        content_body: "Start the day with the roast you know by name.",
        market_id: null,
        scheduled_date: "2026-02-05",
        occasion_key: null,
        clause_codes: ["0.1", "CR.1"],
        rationale: "Grounded in the approval flow and Cairo Roast voice.",
        ...over,
      },
    ],
    notes: "Drafted as a compact plan.",
  };
}

function fakeGenerator<T>(
  response: T,
  captured: { prompt?: string; schema?: object; options?: object } = {},
): StructuredGenerator {
  return async <U>(prompt: string, schema: object, options?: object) => {
    captured.prompt = prompt;
    captured.schema = schema;
    captured.options = options;
    return response as unknown as U;
  };
}

describe("generatePlan", () => {
  it("calls the model in creative mode with scoped brief, calendar and guideline context", async () => {
    const captured: { prompt?: string; schema?: object; options?: { temperature?: number } } = {};
    const input = await inputFor("CL-102");

    const plan = await generatePlan(input, prisma, fakeGenerator(rawPlan(), captured));

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      title: "Morning ritual post",
      content_form: "post",
      platform: "instagram",
      market_id: null,
      clause_codes: ["0.1", "CR.1"],
    });
    expect(plan.items[0].scheduled_date).toBeInstanceOf(Date);

    expect(captured.options?.temperature).toBe(TEMPERATURE.creative);
    expect(captured.prompt).toContain("CL-102");
    expect(captured.prompt).toContain("[CR.1]");
    expect(captured.prompt).not.toContain("[NF.1]");
    expect(captured.prompt).toMatch(/Calendar:/);
  });

  it("accepts a market-specific item only for a market the client operates in", async () => {
    const input = await inputFor("CL-102");
    const eg = await marketId("EG");

    const plan = await generatePlan(
      input,
      prisma,
      fakeGenerator(rawPlan({ market_id: eg, occasion_key: "egypt_revolution_day" })),
    );

    expect(plan.items[0].market_id).toBe(eg);
  });

  it("rejects a market id the client does not operate in", async () => {
    const input = await inputFor("CL-102");
    const sa = await marketId("SA");

    await expect(
      generatePlan(input, prisma, fakeGenerator(rawPlan({ market_id: sa }))),
    ).rejects.toThrow(InvalidGeneratedPlanError);
  });

  it("rejects a market name because only database market ids are authoritative", async () => {
    const input = await inputFor("CL-102");

    await expect(
      generatePlan(input, prisma, fakeGenerator(rawPlan({ market_id: "Egypt" }))),
    ).rejects.toThrow(/which this client does not operate in/);
  });

  it("rejects clause codes outside the retrieved bundle, even when they exist for another client", async () => {
    const input = await inputFor("CL-102");

    await expect(
      generatePlan(input, prisma, fakeGenerator(rawPlan({ clause_codes: ["0.1", "NF.1"] }))),
    ).rejects.toThrow(/NF\.1/);
  });

  it("rejects an item with no clause citation", async () => {
    const input = await inputFor("CL-102");

    await expect(
      generatePlan(input, prisma, fakeGenerator(rawPlan({ clause_codes: [] }))),
    ).rejects.toThrow(/cites no clauses/);
  });

  it("rejects an invalid scheduled date rather than persisting an unreviewable target", async () => {
    const input = await inputFor("CL-102");

    await expect(
      generatePlan(input, prisma, fakeGenerator(rawPlan({ scheduled_date: "next someday" }))),
    ).rejects.toThrow(/invalid scheduled_date/);
  });
});

describe("buildGeneratePlanPrompt", () => {
  it("spells out requested deliverable counts", async () => {
    const input = await inputFor("CL-102");
    const eg = await marketId("EG");
    const prompt = buildGeneratePlanPrompt(input, [
      { market_id: eg, name: "Egypt", country_code: "EG" },
    ]);

    expect(prompt).toContain("1 post: one caption");
    expect(prompt).toContain("1 reel: one reel concept");
  });
});
