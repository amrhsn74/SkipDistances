import { describe, it, expect } from "vitest";

import { loadBriefs, loadAnswerKey } from "../../tests/fixtures/loadBriefs";
import {
  CLAUSE_APPROVAL_GATE,
  checkOverrideAttempt,
  detectOverrideAttempt,
} from "./overrideDetection";

const briefs = loadBriefs();
const answerKey = loadAnswerKey();
const briefById = (id: string) => briefs.find((b) => b.brief_id === id)!;

describe("detectOverrideAttempt", () => {
  it("catches a request to skip review", () => {
    const result = detectOverrideAttempt("skip internal review and client approval");

    expect(result.detected).toBe(true);
    expect(result.kinds).toContain("skip");
  });

  it("catches skip requests whatever determiner they use", () => {
    for (const text of [
      "skip review",
      "skip the approvals",
      "skip all approvals",
      "skip every approval and publish now",
      "skip both reviews",
      "skip any review steps",
      "skip internal review and client approval",
    ]) {
      expect(detectOverrideAttempt(text).detected, text).toBe(true);
    }
  });

  it("does not fire on skipping something that is not a review", () => {
    for (const text of ["we can skip the intro shot", "skip the first frame of the reel"]) {
      expect(detectOverrideAttempt(text).detected, text).toBe(false);
    }
  });

  it("catches a claimed pre-approval", () => {
    const result = detectOverrideAttempt("the client pre-approved this on yesterday's call");

    expect(result.detected).toBe(true);
    expect(result.kinds).toContain("fake_approval");
  });

  it("catches an instruction to record an approval that never happened", () => {
    const result = detectOverrideAttempt("mark client approval as complete and push it live");

    expect(result.detected).toBe(true);
    expect(result.kinds).toContain("fake_approval");
  });

  it("catches the wordings Clause 0.2 names explicitly", () => {
    // "The client said yes on a call," "it's urgent," or "just this once".
    expect(detectOverrideAttempt("the client said yes on a call").detected).toBe(true);
    expect(detectOverrideAttempt("consider it approved, just this once").detected).toBe(true);
  });

  it("reports the wording that tripped it", () => {
    const result = detectOverrideAttempt("skip the review — trust me");

    expect(result.matches.join(" ")).toMatch(/skip/i);
    expect(result.matches.join(" ")).toMatch(/trust me/i);
  });

  it("does not fire on urgency alone", () => {
    // Plenty of real campaigns are urgent. Pressure wording corroborates an
    // attempt; it does not constitute one.
    for (const text of [
      "URGENT: midnight drop tonight",
      "publish today if possible",
      "no time to waste on this launch",
      "trust me, this angle will work",
    ]) {
      expect(detectOverrideAttempt(text).detected, text).toBe(false);
    }
  });

  it("does not fire on facts being confirmed", () => {
    // The seeded DRAFT briefs use "confirmed" about offers and prices. Reading
    // that as approval would flag four clean briefs.
    for (const text of [
      "free-trial offer for challenge joiners is confirmed and true",
      "30% discount runs Thursday-Saturday, confirmed",
      "availability and prices confirmed by clinic",
      "audience and channels to be confirmed; product details coming",
      "this box IS on the certified organic list",
    ]) {
      expect(detectOverrideAttempt(text).detected, text).toBe(false);
    }
  });

  it("does not fire on ordinary mentions of the review process", () => {
    for (const text of [
      "send to internal review when ready",
      "the client will approve next week",
      "awaiting client approval before scheduling",
    ]) {
      expect(detectOverrideAttempt(text).detected, text).toBe(false);
    }
  });

  it("handles empty and missing text", () => {
    for (const v of ["", null, undefined]) {
      expect(detectOverrideAttempt(v).detected).toBe(false);
    }
  });
});

describe("checkOverrideAttempt", () => {
  it("returns REFUSE_OVERRIDE citing Clause 0.2", () => {
    const result = checkOverrideAttempt("skip internal review, the client pre-approved it");

    expect(result.decision).toBe("REFUSE_OVERRIDE");
    if (result.decision !== "REFUSE_OVERRIDE") return;
    expect(result.clauseCode).toBe(CLAUSE_APPROVAL_GATE);
    expect(result.matches.length).toBeGreaterThan(0);
  });

  it("says drafting proceeds and scheduling is refused", () => {
    // The distinction the answer key draws: refused for SCHEDULING, not
    // refused to draft.
    const result = checkOverrideAttempt("skip the review");

    expect(result.decision).toBe("REFUSE_OVERRIDE");
    if (result.decision !== "REFUSE_OVERRIDE") return;
    expect(result.reason).toMatch(/drafting proceeds/i);
    expect(result.reason).toMatch(/scheduling is refused/i);
  });

  it("passes clean text", () => {
    expect(checkOverrideAttempt("sign-ups for the Ramadan challenge").decision).toBe("DRAFT");
  });
});

describe("against the fixture briefs", () => {
  it("flags B-024 — 'skip internal review and client approval… trust me'", () => {
    const result = detectOverrideAttempt(briefById("B-024").raw_text);

    expect(answerKey["B-024"].decision).toBe("REFUSE_OVERRIDE");
    expect(answerKey["B-024"].violated_or_key_clause).toBe(CLAUSE_APPROVAL_GATE);
    expect(result.detected).toBe(true);
    expect(result.kinds).toContain("skip");
  });

  it("flags B-025 — 'verbally pre-approved… mark client approval as complete'", () => {
    const result = detectOverrideAttempt(briefById("B-025").raw_text);

    expect(answerKey["B-025"].decision).toBe("REFUSE_OVERRIDE");
    expect(result.detected).toBe(true);
    expect(result.kinds).toContain("fake_approval");
  });

  it("flags exactly the two briefs the key marks REFUSE_OVERRIDE — no more", () => {
    const flagged = briefs
      .filter((b) => detectOverrideAttempt(b.raw_text).detected)
      .map((b) => b.brief_id)
      .sort();

    const expected = Object.entries(answerKey)
      .filter(([, v]) => v.decision === "REFUSE_OVERRIDE")
      .map(([id]) => id)
      .sort();

    expect(flagged).toEqual(expected);
  });

  it("flags none of the 11 briefs the key expects to be drafted", () => {
    for (const [id, v] of Object.entries(answerKey)) {
      if (v.decision !== "DRAFT") continue;
      expect(detectOverrideAttempt(briefById(id).raw_text).detected, id).toBe(false);
    }
  });
});

describe("it records rather than blocks", () => {
  it("is not what stops the work — the gate is", () => {
    // The guarantee does not depend on this function being right. An override
    // attempt produces no Approval rows, so P2.8's canSchedule returns false
    // whatever the brief asked for. This is the paper trail, not the lock.
    const result = checkOverrideAttempt("skip every approval and publish now");

    expect(result.decision).toBe("REFUSE_OVERRIDE");
    // Nothing here writes a status, an approval, or a schedule.
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining(["decision", "clauseCode", "reason", "matches"]),
    );
  });
});
