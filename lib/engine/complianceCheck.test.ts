import { describe, it, expect } from "vitest";

import { TEMPERATURE } from "../llm/gemini";
import { searchGuidelines } from "./searchGuidelines";
import type { GeneratedPlan, GeneratedPlanItem } from "./generatePlan";
import {
  InvalidComplianceJudgmentError,
  buildCompliancePrompt,
  complianceCheck,
  deterministicCompliance,
  judgeWithGemini,
  type ComplianceJudge,
} from "./complianceCheck";

/**
 * No Gemini calls here. The model judgment is injected so the tests prove the
 * code-owned guarantees around the soft check: deterministic rules short-circuit
 * obvious violations, and model-returned flags cannot cite clauses outside the
 * retrieved client bundle.
 */

function item(over: Partial<GeneratedPlanItem> = {}): GeneratedPlanItem {
  return {
    title: "Morning ritual",
    content_form: "post",
    platform: "instagram",
    content_body: "Meet the roast that makes slow mornings worth it. #CairoRoast",
    market_id: null,
    scheduled_date: new Date("2026-02-05"),
    occasion_key: null,
    clause_codes: ["0.1", "CR.1"],
    rationale: "Warm, artisanal storytelling.",
    ...over,
  };
}

function plan(items: GeneratedPlanItem[]): GeneratedPlan {
  return { items, notes: null };
}

function draftJudge(calls: { count: number } = { count: 0 }): ComplianceJudge {
  return async () => {
    calls.count += 1;
    return { decision: "DRAFT", clause_code: null, flag_type: null, reason: null };
  };
}

describe("deterministicCompliance", () => {
  it("requests substantiation for a generated superlative with no source", async () => {
    const guidelines = await searchGuidelines("CL-108");
    const result = deterministicCompliance(
      item({
        title: "Egypt's best family hotel",
        content_body: "StayEasy is the best hotel chain in Egypt for every break.",
      }),
      guidelines,
      "No award or ranking is cited in this brief.",
    );

    expect(result.decision).toBe("REQUEST_INFO");
    if (result.decision !== "REQUEST_INFO") return;
    expect(result.clauseCode).toBe("1.3");
  });

  it("allows a generated superlative when the brief supplies the source", async () => {
    const guidelines = await searchGuidelines("CL-108");
    const result = deterministicCompliance(
      item({
        title: "Egypt's best family hotel",
        content_body: "StayEasy is the best hotel chain in Egypt for every break.",
      }),
      guidelines,
      "Winner of the 2025 Hospitality Award.",
    );

    expect(result.decision).toBe("DRAFT");
  });

  it("flags health and weight-loss claims under Clause 1.1", async () => {
    const guidelines = await searchGuidelines("CL-101");
    const result = deterministicCompliance(
      item({
        title: "Summer body challenge",
        content_body: "Lose weight in 30 days with before/after transformations.",
      }),
      guidelines,
    );

    expect(result).toMatchObject({
      decision: "FLAG",
      clauseCode: "1.1",
      flagType: "compliance_violation",
    });
  });

  it("flags guaranteed results under Clause 1.2", async () => {
    const guidelines = await searchGuidelines("CL-104");
    const result = deterministicCompliance(
      item({
        title: "Guaranteed returns",
        content_body: "Open the product today for guaranteed returns.",
      }),
      guidelines,
    );

    expect(result).toMatchObject({
      decision: "FLAG",
      clauseCode: "1.2",
      flagType: "compliance_violation",
    });
  });

  it("flags hidden paid disclosure under Clause 1.4", async () => {
    const guidelines = await searchGuidelines("CL-101");
    const result = deterministicCompliance(
      item({
        title: "Influencer collab",
        content_body: "Use a paid influencer post but hide the disclosure.",
      }),
      guidelines,
    );

    expect(result).toMatchObject({
      decision: "FLAG",
      clauseCode: "1.4",
      flagType: "compliance_violation",
    });
  });

  it("flags a discount for Cairo Roast but not for Layla", async () => {
    const cairo = deterministicCompliance(
      item({ content_body: "Use code ROAST20 for 20% off in a weekend flash sale." }),
      await searchGuidelines("CL-102"),
    );
    const layla = deterministicCompliance(
      item({ content_body: "Use code LAYLA20 for 20% off in a weekend flash sale." }),
      await searchGuidelines("CL-105"),
    );

    expect(cairo).toMatchObject({
      decision: "FLAG",
      clauseCode: "CR.4",
      flagType: "brand_violation",
    });
    expect(layla.decision).toBe("DRAFT");
  });

  it("flags uncertified organic language only for GreenGrocer", async () => {
    const bad = deterministicCompliance(
      item({ content_body: "Order the organic full-range grocery box today." }),
      await searchGuidelines("CL-107"),
      "No certification is cited for the full range.",
    );
    const good = deterministicCompliance(
      item({ content_body: "Order the organic vegetable box today." }),
      await searchGuidelines("CL-107"),
      "The vegetable box is on the certified organic list.",
    );

    expect(bad).toMatchObject({
      decision: "FLAG",
      clauseCode: "GG.4",
      flagType: "brand_violation",
    });
    expect(good.decision).toBe("DRAFT");
  });

  it("uses MedCare's own clause for symptom-checklist content", async () => {
    const result = deterministicCompliance(
      item({ content_body: "A symptom checklist: signs you might have a thyroid issue." }),
      await searchGuidelines("CL-103"),
    );

    expect(result).toMatchObject({
      decision: "FLAG",
      clauseCode: "MC.4",
      flagType: "brand_violation",
    });
  });
});

describe("complianceCheck", () => {
  it("passes clean deterministic items through to the model judgment", async () => {
    const calls = { count: 0 };
    const [result] = await complianceCheck(
      {
        plan: plan([item()]),
        guidelines: await searchGuidelines("CL-102"),
        briefContext: "Craft and ritual content.",
      },
      draftJudge(calls),
    );

    expect(calls.count).toBe(1);
    expect(result.source).toBe("model");
    expect(result.outcome.decision).toBe("DRAFT");
  });

  it("does not spend a model judgment on a deterministic violation", async () => {
    const calls = { count: 0 };
    const [result] = await complianceCheck(
      {
        plan: plan([item({ content_body: "Use code ROAST20 for 20% off." })]),
        guidelines: await searchGuidelines("CL-102"),
      },
      draftJudge(calls),
    );

    expect(calls.count).toBe(0);
    expect(result.source).toBe("deterministic");
    expect(result.outcome).toMatchObject({ decision: "FLAG", clauseCode: "CR.4" });
  });

  it("accepts a model flag only when its clause was retrieved", async () => {
    const judge: ComplianceJudge = async () => ({
      decision: "FLAG",
      clause_code: "CR.4",
      flag_type: "brand_violation",
      reason: "Price-led messaging conflicts with Cairo Roast.",
    });

    const [result] = await complianceCheck(
      {
        plan: plan([item({ content_body: "A subtle value-led message." })]),
        guidelines: await searchGuidelines("CL-102"),
      },
      judge,
    );

    expect(result.outcome).toMatchObject({
      decision: "FLAG",
      clauseCode: "CR.4",
      flagType: "brand_violation",
    });
  });

  it("rejects a model flag citing another client's clause", async () => {
    const judge: ComplianceJudge = async () => ({
      decision: "FLAG",
      clause_code: "NF.4",
      flag_type: "brand_violation",
      reason: "Wrong client clause.",
    });

    await expect(
      complianceCheck(
        {
          plan: plan([item({ content_body: "A subtle value-led message." })]),
          guidelines: await searchGuidelines("CL-102"),
        },
        judge,
      ),
    ).rejects.toThrow(InvalidComplianceJudgmentError);
  });
});

describe("judgeWithGemini", () => {
  it("uses the deterministic temperature and compliance schema", async () => {
    const captured: { prompt?: string; schema?: object; options?: { temperature?: number } } = {};
    const generator = async <T>(promptText: string, schema: object, options?: object) => {
      captured.prompt = promptText;
      captured.schema = schema;
      captured.options = options as { temperature?: number };
      return {
        decision: "DRAFT",
        clause_code: null,
        flag_type: null,
        reason: null,
      } as T;
    };

    await judgeWithGemini(
      item(),
      { guidelines: await searchGuidelines("CL-102"), briefContext: "Ritual post." },
      generator,
    );

    expect(captured.options?.temperature).toBe(TEMPERATURE.deterministic);
    expect(captured.prompt).toContain("Retrieved clauses");
    expect(captured.prompt).toContain("[CR.1]");
    expect(captured.prompt).not.toContain("[NF.1]");
  });
});

describe("buildCompliancePrompt", () => {
  it("includes the item and retrieved guidelines", async () => {
    const prompt = buildCompliancePrompt(item(), {
      guidelines: await searchGuidelines("CL-102"),
      briefContext: "Coffee ritual.",
    });

    expect(prompt).toContain("Morning ritual");
    expect(prompt).toContain("Coffee ritual.");
    expect(prompt).toContain("[CR.1]");
  });
});
