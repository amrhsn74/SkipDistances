import { ok, requestInfo, type Outcome } from "./decision";

/**
 * Clause 0.5 — Incomplete briefs.
 *
 * "A brief must state the client, the objective, the target audience, and the
 * channels. If any is missing, do not guess — request the missing information
 * from the account manager."
 *
 * Deliberately not a model call: "did the human write this down" is a fact
 * about the text, and guessing is the exact failure the clause exists to
 * prevent.
 */

export const CLAUSE_INCOMPLETE_BRIEF = "0.5";

/** The four fields Clause 0.5 names, in the order it names them. */
export const REQUIRED_BRIEF_FIELDS = ["client", "objective", "audience", "channels"] as const;

export type RequiredBriefField = (typeof REQUIRED_BRIEF_FIELDS)[number];

export type BriefFields = Partial<Record<RequiredBriefField | string, string | null | undefined>>;

/**
 * Placeholders that look like an answer but state nothing. The fixture set
 * contains both shapes of incompleteness: B-012 omits `audience` and `channels`
 * entirely, while B-013 writes "(not stated)" for them. Treating only the first
 * as missing would pass B-013 straight through to drafting.
 */
const PLACEHOLDER_PATTERNS = [
  /^\(?\s*not\s+stated\s*\)?$/i,
  /^\(?\s*none\s*\)?$/i,
  /^\(?\s*n\/?a\s*\)?$/i,
  /^\(?\s*tbc\s*\)?$/i,
  /^\(?\s*tbd\s*\)?$/i,
  /^\(?\s*to\s+be\s+(confirmed|decided|determined)\s*\)?$/i,
  /^\(?\s*unknown\s*\)?$/i,
  /^-+$/,
  /^\?+$/,
];

/** True when a value is absent, blank, or a placeholder standing in for one. */
export function isMissing(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  const trimmed = value.trim();
  if (trimmed === "") return true;
  return PLACEHOLDER_PATTERNS.some((p) => p.test(trimmed));
}

export function findMissingFields(brief: BriefFields): RequiredBriefField[] {
  return REQUIRED_BRIEF_FIELDS.filter((f) => isMissing(brief[f]));
}

/**
 * Pass, or REQUEST_INFO citing 0.5 with the missing fields named -- named so the
 * account manager knows exactly what to supply, rather than being told the brief
 * is "incomplete".
 */
export function checkBriefComplete(brief: BriefFields): Outcome<BriefFields> {
  const missing = findMissingFields(brief);

  if (missing.length === 0) return ok(brief);

  return requestInfo(
    CLAUSE_INCOMPLETE_BRIEF,
    missing,
    `The brief does not state: ${missing.join(", ")}. Clause 0.5 requires the client, objective, audience and channels before drafting.`,
  );
}
