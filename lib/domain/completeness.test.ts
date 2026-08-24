import { describe, it, expect } from "vitest";

import { loadBriefs, loadAnswerKey } from "../../fixtures/loadBriefs";
import {
  checkBriefComplete,
  findMissingFields,
  isMissing,
  CLAUSE_INCOMPLETE_BRIEF,
  REQUIRED_BRIEF_FIELDS,
} from "./completeness";

const briefs = loadBriefs();
const answerKey = loadAnswerKey();
const briefById = (id: string) => briefs.find((b) => b.brief_id === id)!;

describe("isMissing", () => {
  it("treats absent and blank values as missing", () => {
    for (const v of [null, undefined, "", "   "]) {
      expect(isMissing(v)).toBe(true);
    }
  });

  it("treats placeholders as missing -- B-013 writes '(not stated)', not nothing", () => {
    for (const v of ["(not stated)", "not stated", "TBC", "tbd", "N/A", "none", "unknown", "--"]) {
      expect(isMissing(v)).toBe(true);
    }
  });

  it("treats a real value as present", () => {
    for (const v of ["18-30 casual exercisers", "Instagram and TikTok", "CL-101"]) {
      expect(isMissing(v)).toBe(false);
    }
  });
});

describe("checkBriefComplete", () => {
  it("passes a complete brief", () => {
    const result = checkBriefComplete({
      client: "CL-101",
      objective: "sign-ups for the challenge",
      audience: "18-30",
      channels: "Instagram and TikTok",
    });

    expect(result.decision).toBe("DRAFT");
  });

  it("names every missing field, so the account manager knows what to supply", () => {
    const result = checkBriefComplete({ client: "CL-106", objective: "support the launch" });

    expect(result.decision).toBe("REQUEST_INFO");
    if (result.decision !== "REQUEST_INFO") return;

    expect(result.clauseCode).toBe(CLAUSE_INCOMPLETE_BRIEF);
    expect(result.missing).toEqual(["audience", "channels"]);
    expect(result.reason).toMatch(/audience/);
    expect(result.reason).toMatch(/channels/);
  });

  it("requires all four fields Clause 0.5 names", () => {
    const complete = {
      client: "CL-101",
      objective: "o",
      audience: "a",
      channels: "c",
    };

    for (const field of REQUIRED_BRIEF_FIELDS) {
      const result = checkBriefComplete({ ...complete, [field]: undefined });
      expect(result.decision).toBe("REQUEST_INFO");
      if (result.decision !== "REQUEST_INFO") continue;
      expect(result.missing).toEqual([field]);
    }
  });
});

describe("against the fixture briefs", () => {
  it("B-012 is incomplete -- fields omitted entirely", () => {
    const b = briefById("B-012");
    const result = checkBriefComplete(b.fields);

    expect(answerKey["B-012"].decision).toBe("REQUEST_INFO");
    expect(answerKey["B-012"].violated_or_key_clause).toBe(CLAUSE_INCOMPLETE_BRIEF);
    expect(result.decision).toBe("REQUEST_INFO");
    if (result.decision !== "REQUEST_INFO") return;
    expect(result.missing).toContain("audience");
    expect(result.missing).toContain("channels");
  });

  it("B-013 is incomplete -- fields present but written '(not stated)'", () => {
    const b = briefById("B-013");

    // The distinction that matters: the keys exist, so a presence-only check
    // would wave this brief through.
    expect(b.fields.audience).toBe("(not stated)");
    expect(b.fields.channels).toBe("(not stated)");

    const result = checkBriefComplete(b.fields);

    expect(answerKey["B-013"].decision).toBe("REQUEST_INFO");
    expect(result.decision).toBe("REQUEST_INFO");
    if (result.decision !== "REQUEST_INFO") return;
    expect(result.missing).toEqual(["audience", "channels"]);
  });

  it("does not hold back a brief the key expects to be drafted", () => {
    // Every DRAFT brief in the key must clear Clause 0.5 on the text alone.
    const drafted = Object.entries(answerKey).filter(([, v]) => v.decision === "DRAFT");
    expect(drafted.length).toBeGreaterThan(0);

    for (const [id] of drafted) {
      const result = checkBriefComplete(briefById(id).fields);
      expect(
        result.decision,
        `${id} expected DRAFT but completeness held it: ${
          result.decision === "REQUEST_INFO" ? result.missing.join(", ") : ""
        }`,
      ).toBe("DRAFT");
    }
  });

  it("holds exactly the two briefs the key attributes to Clause 0.5", () => {
    const held = briefs
      .filter((b) => checkBriefComplete(b.fields).decision === "REQUEST_INFO")
      .map((b) => b.brief_id);

    const expected = Object.entries(answerKey)
      .filter(([, v]) => v.violated_or_key_clause === CLAUSE_INCOMPLETE_BRIEF)
      .map(([id]) => id);

    expect(held.sort()).toEqual(expected.sort());
  });

  it("does not hold B-014 -- its REQUEST_INFO is Clause 1.3, not 0.5", () => {
    // B-014 states all four fields; what it lacks is substantiation for "best
    // hotel chain in Egypt". That is P2.3a's job, at item level, not this one's.
    const result = checkBriefComplete(briefById("B-014").fields);

    expect(result.decision).toBe("DRAFT");
    expect(answerKey["B-014"].decision).toBe("REQUEST_INFO");
    expect(answerKey["B-014"].violated_or_key_clause).toBe("1.3");
  });
});

describe("findMissingFields", () => {
  it("returns fields in the order Clause 0.5 names them", () => {
    expect(findMissingFields({})).toEqual(["client", "objective", "audience", "channels"]);
  });
});
