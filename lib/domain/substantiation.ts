import { ok, requestInfo, type Outcome } from "./decision";

/**
 * Clause 1.3 — Superlatives need substantiation.
 *
 * "'The best,' '#1,' 'Egypt's leading' may be used only if the brief includes a
 * source (an award, a market report). Unsubstantiated superlatives are softened
 * or flagged."
 *
 * This is the SECOND REQUEST_INFO path, and a distinct one from Clause 0.5.
 * 0.5 asks whether the human filled the brief in; this asks whether a specific
 * claim inside it can be backed up. A brief can be perfectly complete and still
 * land here -- B-014 states all four required fields and still cannot be drafted
 * as written, because "the best hotel chain in Egypt" has nothing behind it.
 *
 * The outcome is per-claim, so the engine holds back only the offending item
 * rather than the whole plan (PRD §3, "Flag resolution").
 */

export const CLAUSE_SUPERLATIVE = "1.3";

/**
 * Superlative claims. Each needs a source before it can be drafted.
 * Word-boundary anchored so "bestseller" or "topical" do not trip it.
 */
const SUPERLATIVE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bthe\s+best\b/i, label: "the best" },
  { pattern: /\bbest\s+(?:\w+\s+){0,2}(?:chain|brand|company|hotel|app|bank|service|product|clinic|choice)\b/i, label: "best <category>" },
  { pattern: /#\s?1\b/, label: "#1" },
  { pattern: /\bnumber\s+one\b/i, label: "number one" },
  { pattern: /\bleading\b/i, label: "leading" },
  { pattern: /\bworld[''`]?s\s+(?:best|leading|finest|top)\b/i, label: "world's best/leading" },
  { pattern: /\b(?:top|first)\s+rated\b/i, label: "top rated" },
  { pattern: /\bunbeatable\b/i, label: "unbeatable" },
  { pattern: /\bfastest[- ]growing\b/i, label: "fastest-growing" },
  { pattern: /\bmost\s+(?:trusted|popular|loved|advanced)\b/i, label: "most trusted/popular" },
];

/**
 * Wording that supplies a source. Clause 1.3 names an award or a market report;
 * the fixture set also uses a client-supplied citable statistic (B-004,
 * "internal 2025 study, citable") and a certification (B-005, "IS on the
 * certified organic list").
 */
const SOURCE_PATTERNS = [
  /\baward(?:ed|s)?\b/i,
  /\branking?\b/i,
  /\brank(?:ed)?\s+(?:#|no\.?|number)?\s*\d+/i,
  /\bmarket\s+report\b/i,
  /\breport\b/i,
  /\bstudy\b/i,
  /\bsurvey\b/i,
  /\bcertif(?:ied|ication)\b/i,
  /\bcitable\b/i,
  /\bsource[ds]?\b/i,
  /\baccording\s+to\b/i,
  /\bper\s+\w+\s+\d{4}\b/i,
];

/**
 * Negations that mention a source only to say there isn't one. B-014's notes
 * read "no award or ranking is cited in this brief" -- a naive keyword search
 * for "award" would read that as substantiation and draft the very claim the
 * clause forbids.
 */
const NEGATED_SOURCE_PATTERNS = [
  /\bno\s+(?:award|ranking|source|report|study|survey|citation|proof|evidence|substantiation)\b/i,
  /\b(?:not|isn[''`]?t|aren[''`]?t)\s+(?:cited|substantiated|sourced|provided|available)\b/i,
  /\bwithout\s+(?:an?\s+)?(?:award|ranking|source|report|study|citation)\b/i,
  /\bunsubstantiated\b/i,
  /\bnone\s+(?:is\s+)?(?:provided|cited|available)\b/i,
];

export type SubstantiationResult = {
  /** Superlative phrases found, for the human who reads the request. */
  claims: string[];
  hasSource: boolean;
};

export function findSuperlatives(text: string): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const { pattern, label } of SUPERLATIVE_PATTERNS) {
    const m = pattern.exec(text);
    if (m) found.push(`${label} ("${m[0].trim()}")`);
  }
  return found;
}

/**
 * Whether the text supplies a source. A negated mention does not count, and is
 * checked first: "no award is cited" contains "award".
 */
export function hasSubstantiation(text: string): boolean {
  if (!text) return false;
  if (NEGATED_SOURCE_PATTERNS.some((p) => p.test(text))) return false;
  return SOURCE_PATTERNS.some((p) => p.test(text));
}

/**
 * Pass, or REQUEST_INFO citing 1.3 naming the claims that need backing.
 *
 * `text` is the whole brief (or one proposed item): the claim and its source can
 * sit in different fields, as in B-014 where the superlative is the objective and
 * the notes address the source.
 */
export function checkSubstantiation(text: string): Outcome<SubstantiationResult> {
  const claims = findSuperlatives(text ?? "");

  if (claims.length === 0) {
    return ok({ claims: [], hasSource: false });
  }

  const hasSource = hasSubstantiation(text);
  if (hasSource) {
    return ok({ claims, hasSource: true });
  }

  return requestInfo(
    CLAUSE_SUPERLATIVE,
    claims,
    `Superlative claim with no source: ${claims.join("; ")}. Clause 1.3 allows it only with an award, ranking or market report — supply the source, or the claim must be softened.`,
  );
}
