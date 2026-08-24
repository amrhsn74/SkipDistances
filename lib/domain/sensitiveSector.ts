/**
 * Clause 1.8 — Sensitive-sector clients.
 *
 * "Healthcare, financial, and government clients are sensitive: their content
 * always carries the strictest reading of these rules, and their plans are
 * always marked for mandatory client-side compliance review, even when routine."
 *
 * This is the single source of truth for the derivation. The seed imports it to
 * write Client.sensitive_sector, and the engine calls it at queue_or_flag --
 * two copies would mean a client marked sensitive at seed time and read as
 * ordinary at draft time.
 *
 * `industry` is free text in the roster: 18 distinct values across 150 clients,
 * with near-duplicates like "f&b" and "food & beverage". Matching on equality
 * would silently miss clients, so this normalizes and matches on whole words.
 *
 * Whole words, not substrings: the roster contains "hospitality" (StayEasy
 * Hotels), and a substring match on "hospital" marks a hotel chain as a
 * healthcare client -- forcing mandatory compliance review on every campaign it
 * ever runs. Over-matching here is not a safe default; it is a different wrong
 * answer.
 */

export const CLAUSE_SENSITIVE_SECTOR = "1.8";

/**
 * The three sectors Clause 1.8 names, and the wordings the roster uses.
 * Matched against whole words in the normalized industry, with a trailing "s"
 * tolerated ("clinics", "banks").
 */
const SENSITIVE_TERMS = [
  // healthcare
  "health",
  "healthcare",
  "medical",
  "medicine",
  "clinic",
  "hospital",
  "pharma",
  "pharmaceutical",
  "pharmaceuticals",
  "dental",
  "dentistry",
  // financial
  "financial",
  "finance",
  "bank",
  "banking",
  "insurance",
  "lending",
  "investment",
  "investments",
  // government
  "government",
  "governmental",
  "public sector",
  "ministry",
  "municipal",
];

export function normalizeIndustry(industry: string | null | undefined): string {
  return (industry ?? "")
    .toLowerCase()
    .replace(/[&/_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSensitiveSector(industry: string | null | undefined): boolean {
  const normalized = normalizeIndustry(industry);
  if (!normalized) return false;

  const words = new Set(normalized.split(" ").map((w) => w.replace(/s$/, "")));

  return SENSITIVE_TERMS.some((term) => {
    // Multi-word terms ("public sector") are checked against the whole string.
    if (term.includes(" ")) return normalized.includes(term);
    return words.has(term.replace(/s$/, ""));
  });
}

/**
 * Whether a campaign for this client must be marked
 * `compliance_review_required`. Set at queue_or_flag (P3.8) for every item in
 * the plan, even when the brief is otherwise clean.
 */
export function requiresComplianceReview(industry: string | null | undefined): boolean {
  return isSensitiveSector(industry);
}
