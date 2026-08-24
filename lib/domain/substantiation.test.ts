import { describe, it, expect } from "vitest";

import { loadBriefs, loadAnswerKey } from "../../tests/fixtures/loadBriefs";
import {
  checkSubstantiation,
  findSuperlatives,
  hasSubstantiation,
  CLAUSE_SUPERLATIVE,
} from "./substantiation";

const briefs = loadBriefs();
const answerKey = loadAnswerKey();
const briefById = (id: string) => briefs.find((b) => b.brief_id === id)!;

describe("findSuperlatives", () => {
  it("finds the phrasings Clause 1.3 names", () => {
    expect(findSuperlatives("the best hotel chain in Egypt")).not.toHaveLength(0);
    expect(findSuperlatives("Egypt's leading provider")).not.toHaveLength(0);
    expect(findSuperlatives("we are #1 in the market")).not.toHaveLength(0);
    expect(findSuperlatives("the number one choice")).not.toHaveLength(0);
  });

  it("ignores ordinary copy with no superlative claim", () => {
    for (const text of [
      "sign-ups for the 30-day Ramadan steps challenge",
      "orders for the NEW certified-organic vegetable box",
      "deposits into the new savings product",
    ]) {
      expect(findSuperlatives(text)).toHaveLength(0);
    }
  });

  it("does not trip on words that merely contain a superlative", () => {
    // "bestseller" and "topical" are not claims about being the best.
    expect(findSuperlatives("our bestseller returns this week")).toHaveLength(0);
    expect(findSuperlatives("a topical piece on winter recipes")).toHaveLength(0);
  });
});

describe("hasSubstantiation", () => {
  it("accepts an award, ranking, report, study or certification", () => {
    for (const text of [
      "winner of the 2025 Hospitality Award",
      "ranked #1 in the 2025 market report",
      "internal 2025 study, citable",
      "this box IS on the certified organic list",
    ]) {
      expect(hasSubstantiation(text)).toBe(true);
    }
  });

  it("rejects a mention that only says there is no source", () => {
    // The trap: these strings all contain a source keyword.
    for (const text of [
      "no award or ranking is cited in this brief",
      "no source provided",
      "the claim is unsubstantiated",
      "without an award",
      "none is cited",
    ]) {
      expect(hasSubstantiation(text)).toBe(false);
    }
  });
});

describe("checkSubstantiation", () => {
  it("passes text with no superlative at all", () => {
    expect(checkSubstantiation("orders for the new veg box").decision).toBe("DRAFT");
  });

  it("passes a superlative that carries a source", () => {
    const result = checkSubstantiation(
      "position us as the best hotel chain — winner of the 2025 Hospitality Award",
    );

    expect(result.decision).toBe("DRAFT");
    if (result.decision !== "DRAFT") return;
    expect(result.value.hasSource).toBe(true);
    expect(result.value.claims).not.toHaveLength(0);
  });

  it("requests info for a superlative with no source, citing 1.3", () => {
    const result = checkSubstantiation("position StayEasy as the best hotel chain in Egypt");

    expect(result.decision).toBe("REQUEST_INFO");
    if (result.decision !== "REQUEST_INFO") return;
    expect(result.clauseCode).toBe(CLAUSE_SUPERLATIVE);
    expect(result.missing).not.toHaveLength(0);
    expect(result.reason).toMatch(/source/i);
  });
});

describe("against the fixture briefs", () => {
  it("B-014 -> REQUEST_INFO on 1.3, the case P2.3's Clause 0.5 check lets through", () => {
    const b = briefById("B-014");
    const result = checkSubstantiation(b.raw_text);

    expect(answerKey["B-014"].decision).toBe("REQUEST_INFO");
    expect(answerKey["B-014"].violated_or_key_clause).toBe(CLAUSE_SUPERLATIVE);

    expect(result.decision).toBe("REQUEST_INFO");
    if (result.decision !== "REQUEST_INFO") return;
    expect(result.clauseCode).toBe(CLAUSE_SUPERLATIVE);
  });

  it("B-014's notes mention 'award' only to deny it -- a keyword search would draft it", () => {
    const b = briefById("B-014");

    expect(b.raw_text).toMatch(/award/i);
    expect(hasSubstantiation(b.raw_text)).toBe(false);
  });

  it("B-004 and B-005 cite real sources and are not held", () => {
    for (const id of ["B-004", "B-005"]) {
      expect(answerKey[id].decision).toBe("DRAFT");
      expect(checkSubstantiation(briefById(id).raw_text).decision).toBe("DRAFT");
    }
  });

  it("holds no brief the answer key expects to be drafted", () => {
    const drafted = Object.entries(answerKey).filter(([, v]) => v.decision === "DRAFT");

    for (const [id] of drafted) {
      const result = checkSubstantiation(briefById(id).raw_text);
      expect(
        result.decision,
        `${id} expected DRAFT but substantiation held it: ${
          result.decision === "REQUEST_INFO" ? result.missing.join("; ") : ""
        }`,
      ).toBe("DRAFT");
    }
  });

  it("is the only check that holds B-014 -- 1.3 is an item-level claim, not a missing field", () => {
    const held = briefs
      .filter((b) => checkSubstantiation(b.raw_text).decision === "REQUEST_INFO")
      .map((b) => b.brief_id);

    expect(held).toContain("B-014");
  });
});
