import { describe, it, expect } from "vitest";

import { prisma } from "../db";
import {
  type GuidelineBundle,
  formatGuidelinesForPrompt,
  isCitable,
  searchGuidelines,
  uncitableCodes,
} from "./searchGuidelines";

/**
 * The wrapper's own decisions. The double-scoped query that makes cross-client
 * leakage structurally impossible is Phase 2's and tested there; what matters
 * here is that clause codes survive into the prompt and that a citation is
 * validated rather than trusted.
 */

/** A hero client with a brand guide, and one of the 142 without. */
const WITH_GUIDE = "CL-102"; // Cairo Roast, CR.* clauses
const WITHOUT_GUIDE = "CL-120";

describe("searchGuidelines", () => {
  it("gives a hero client agency standards plus their own brand clauses", async () => {
    const bundle = await searchGuidelines(WITH_GUIDE);

    expect(bundle.agency.length).toBe(20);
    expect(bundle.brand.length).toBeGreaterThan(0);
    expect(bundle.all.length).toBe(bundle.agency.length + bundle.brand.length);

    // Only this client's clauses. The prefix check is a proxy for the scoping
    // that Phase 2 enforces -- if another client's guide ever leaked in, its
    // codes would not start with CR.
    expect(bundle.brand.every((c) => c.clause_code.startsWith("CR."))).toBe(true);
  });

  it("governs a client with no brand guide by agency standards alone", async () => {
    const bundle = await searchGuidelines(WITHOUT_GUIDE);

    // The majority of the roster. A normal case, not a degraded one.
    expect(bundle.brandGuideVersionId).toBeNull();
    expect(bundle.brand).toEqual([]);
    expect(bundle.agency.length).toBe(20);
  });

  it("lists every retrieved code, for validating citations against", async () => {
    const bundle = await searchGuidelines(WITH_GUIDE);

    expect(bundle.availableCodes).toHaveLength(bundle.all.length);
    expect(bundle.availableCodes).toContain("0.6");
    expect(bundle.availableCodes.some((c) => c.startsWith("CR."))).toBe(true);
  });

  it("does not truncate the seeded corpus", async () => {
    const bundle = await searchGuidelines(WITH_GUIDE);

    // 20 agency + at most 8 brand clauses is nowhere near the cap. If this ever
    // fails, a prompt is silently losing rules.
    expect(bundle.truncated).toBe(false);
    expect(bundle.omittedCodes).toEqual([]);
  });
});

describe("truncation keeps compliance rules over brand voice", () => {
  it("drops brand clauses first when the corpus exceeds the cap", async () => {
    // The seeded corpus never approaches the real cap, so the cap is lowered to
    // drive the actual keep-loop rather than a copy of it.
    const bundle = await searchGuidelines(WITH_GUIDE, prisma, 2_000);

    expect(bundle.truncated).toBe(true);
    expect(bundle.omittedCodes.length).toBeGreaterThan(0);

    // If anything has to go it must not be the compliance rules that govern
    // every client -- brand voice is what a plan can afford to lose.
    expect(bundle.agency.length).toBeGreaterThan(0);
    expect(bundle.brand).toEqual([]);
    expect(bundle.omittedCodes.some((c) => c.startsWith("CR."))).toBe(true);
  });

  it("keeps availableCodes in step with what survived", async () => {
    const bundle = await searchGuidelines(WITH_GUIDE, prisma, 2_000);

    // A citation validated against codes that were dropped from the prompt
    // would accept a clause the model was never shown.
    expect(bundle.availableCodes).toEqual(bundle.all.map((c) => c.clause_code));
    for (const omitted of bundle.omittedCodes) {
      expect(isCitable(bundle, omitted)).toBe(false);
    }
  });
});

describe("citation validation", () => {
  it("accepts a code that was retrieved and rejects one that was not", async () => {
    const bundle = await searchGuidelines(WITH_GUIDE);

    expect(isCitable(bundle, "0.6")).toBe(true);
    // A model asked to cite will produce a plausible code it never saw.
    expect(isCitable(bundle, "CR.99")).toBe(false);
    expect(isCitable(bundle, "NF.2")).toBe(false); // another client's guide
  });

  it("names every hallucinated citation in a list", async () => {
    const bundle = await searchGuidelines(WITH_GUIDE);

    expect(uncitableCodes(bundle, ["0.6", "CR.99", "1.3", "NF.2"])).toEqual([
      "CR.99",
      "NF.2",
    ]);
    expect(uncitableCodes(bundle, ["0.6", "1.3"])).toEqual([]);
  });

  it("rejects another client's brand codes even though they exist in the corpus", async () => {
    // The sharpest case: NF.2 is a real clause, just not this client's. A check
    // against the whole guideline table rather than the retrieved bundle would
    // pass this and let a citation cross clients.
    const cairoRoast = await searchGuidelines(WITH_GUIDE);
    const nileFit = await searchGuidelines("CL-101");

    const nfCode = nileFit.brand[0].clause_code;
    expect(isCitable(nileFit, nfCode)).toBe(true);
    expect(isCitable(cairoRoast, nfCode)).toBe(false);
  });
});

describe("formatGuidelinesForPrompt", () => {
  it("leads every clause with its code", async () => {
    const bundle = await searchGuidelines(WITH_GUIDE);
    const text = formatGuidelinesForPrompt(bundle);

    // The code is what a draft must cite and what Phase 12 grades against.
    // Buried after the text, a model cites by title instead.
    expect(text).toMatch(/\[0\.6\]/);
    expect(text).toMatch(/\[CR\.\d+\]/);
  });

  it("separates agency standards from this client's brand rules", async () => {
    const text = formatGuidelinesForPrompt(await searchGuidelines(WITH_GUIDE));

    expect(text).toMatch(/agency standards/i);
    expect(text).toMatch(/brand guidelines/i);
  });

  it("tells the model plainly when a client has no brand guide", async () => {
    const text = formatGuidelinesForPrompt(await searchGuidelines(WITHOUT_GUIDE));

    // Otherwise the absence reads as an omission, and the model invents a house
    // style to fill it.
    expect(text).toMatch(/no brand guide on file/i);
    expect(text).toMatch(/do not infer a house style/i);
  });

  it("reports a retrieval failure rather than looking like a client with no rules", () => {
    const empty: GuidelineBundle = {
      clientId: "CL-999",
      brandGuideVersionId: null,
      agency: [],
      brand: [],
      all: [],
      availableCodes: [],
      truncated: false,
      omittedCodes: [],
    };

    // Unreachable in practice -- agency clauses govern everyone -- so if it
    // happens, the prompt must say so instead of returning "".
    const text = formatGuidelinesForPrompt(empty);
    expect(text).toMatch(/retrieval failure/i);
    expect(text).toMatch(/do not draft/i);
  });
});
