import { describe, it, expect } from "vitest";

import { isConfigured } from "../llm/gemini";
import { loadBriefs } from "../../tests/fixtures/loadBriefs";
import { analyzeBrief, isBlankValue } from "./analyzeBrief";

/**
 * The real extraction, against all 27 fixture briefs.
 *
 * Needs GEMINI_API_KEY and makes 27 calls, so it is skipped when no key is set
 * rather than failing — the data and domain layers must stay runnable without
 * one. Run it with `npm run test:live`.
 *
 * The assertion that matters, and the one the plan asks for: extraction must not
 * silently drop a field a human can see in the text. So the fixture loader —
 * which reads what is literally on the page and interprets nothing — is used as
 * the oracle. Where it can see a value, the model must have seen it too.
 */

const briefs = loadBriefs();
const live = isConfigured() ? describe : describe.skip;

/**
 * The free tier allows 15 requests per minute for flash-lite. 27 briefs
 * exhausts that partway through, so calls are paced rather than fired in a
 * burst -- and a 429 is retried once after the delay the API itself names,
 * because a quota bounce is not an extraction defect.
 */
const PACE_MS = 4_500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryDelayMs(error: unknown): number | null {
  const text = error instanceof Error ? error.message : String(error);
  if (!text.includes("RESOURCE_EXHAUSTED") && !text.includes("429")) return null;
  const m = /"retryDelay":"(\d+)s"/.exec(text) ?? /retry in ([\d.]+)s/.exec(text);
  return m ? Math.ceil(Number(m[1]) * 1000) + 1_000 : 30_000;
}

async function analyzePaced(text: string) {
  try {
    return await analyzeBrief(text);
  } catch (e) {
    const delay = retryDelayMs(e);
    if (delay === null) throw e;
    await sleep(delay);
    return analyzeBrief(text);
  }
}

/** Fields the header block names, mapped to the analysis field they become. */
const HEADER_FIELDS: Array<[string, "objective" | "audience" | "notes"]> = [
  ["objective", "objective"],
  ["audience", "audience"],
  ["notes", "notes"],
];

live("analyzeBrief against the 27 fixture briefs", () => {
  // One extraction per brief, shared across the assertions below.
  const extracted = new Map<string, Awaited<ReturnType<typeof analyzeBrief>>>();

  it(
    "extracts every brief without throwing",
    async () => {
      for (const b of briefs) {
        extracted.set(b.brief_id, await analyzePaced(b.raw_text));
        await sleep(PACE_MS);
      }
      expect(extracted.size).toBe(27);
    },
    600_000,
  );

  it("never invents a client id the brief does not contain", () => {
    for (const b of briefs) {
      // Verified in code, so this holds regardless of the model -- but if it
      // ever fails, the unknown-client path has been skipped for a real brief.
      expect(extracted.get(b.brief_id)!.client_id, b.brief_id).toBe(b.client_id);
    }
  });

  it("drops no field a human can see on the page", () => {
    const dropped: string[] = [];

    for (const b of briefs) {
      const a = extracted.get(b.brief_id)!;

      for (const [headerKey, analysisKey] of HEADER_FIELDS) {
        const onPage = b.fields[headerKey];
        // Only fields the brief actually states. A blank marker is the brief
        // saying nothing, and must stay absent.
        if (isBlankValue(onPage)) continue;

        if (isBlankValue(a[analysisKey])) {
          dropped.push(`${b.brief_id}.${analysisKey} — page says "${onPage}"`);
        }
      }

      if (!isBlankValue(b.fields["channels"]) && a.channels.length === 0) {
        dropped.push(`${b.brief_id}.channels — page says "${b.fields["channels"]}"`);
      }
      if (!isBlankValue(b.fields["deliverables"]) && a.deliverables.length === 0) {
        dropped.push(`${b.brief_id}.deliverables — page says "${b.fields["deliverables"]}"`);
      }
    }

    expect(dropped, `extraction dropped:\n${dropped.join("\n")}`).toEqual([]);
  });

  it("reports a blank field as missing rather than filling it in", () => {
    // B-013 is the Clause 0.5 case: audience and channels are "(not stated)".
    // A model that helpfully supplies them deletes the rule.
    const b013 = extracted.get("B-013")!;

    expect(b013.audience).toBeNull();
    expect(b013.channels).toEqual([]);
    expect(b013.explicitly_missing).toEqual(
      expect.arrayContaining(["audience", "channels"]),
    );
  });

  it("keeps override language in notes, where P2.10 can still see it", () => {
    // B-024 tries to skip both approval stages. If extraction summarises the
    // notes away, override detection has nothing left to match on.
    const notes = extracted.get("B-024")!.notes ?? "";

    expect(notes.toLowerCase()).toContain("skip");
    expect(notes.toLowerCase()).toMatch(/review|approval/);
  });

  it("carries the unsubstantiated claim through for Clause 1.3", () => {
    // B-014's "best hotel chain in Egypt" must survive extraction, or the
    // substantiation check never gets to fire.
    const a = extracted.get("B-014")!;
    const text = [a.objective, a.notes, a.title].filter(Boolean).join(" ").toLowerCase();

    expect(text).toMatch(/best|leading|number one|#1/);
  });

  it("is stable across runs at deterministic temperature", async () => {
    // The Phase 12 evaluation is meaningless if the same brief reads
    // differently on two runs.
    const b = briefs.find((x) => x.brief_id === "B-001")!;
    const a1 = await analyzePaced(b.raw_text);
    await sleep(PACE_MS);
    const a2 = await analyzePaced(b.raw_text);

    expect(a2.client_id).toBe(a1.client_id);
    expect(a2.channels.sort()).toEqual(a1.channels.sort());
    expect(a2.deliverables.length).toBe(a1.deliverables.length);
  }, 180_000);
});
