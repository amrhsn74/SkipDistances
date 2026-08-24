/**
 * Clause 1.8 — Sensitive-sector clients.
 *
 * `industry` is free text in the roster: 18 distinct values across 150 clients,
 * with near-duplicates like "f&b" / "food & beverage". Matching on equality
 * would silently miss clients, so this normalizes first and matches on
 * substrings.
 *
 * This is the single source of truth for the derivation. The seed writes
 * Client.sensitive_sector from it, and Phase 2's lib/domain/sensitiveSector.ts
 * re-exports it rather than reimplementing the rule.
 */

const SENSITIVE_PATTERNS = [
  "health",     // healthcare, health services
  "medical",
  "clinic",
  "pharma",
  "financial",  // financial services
  "finance",
  "bank",       // retail banking
  "insurance",
  "government",
  "public sector",
];

export function normalizeIndustry(industry: string | null | undefined): string {
  return (industry ?? "").toLowerCase().replace(/[&/_-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function isSensitiveSector(industry: string | null | undefined): boolean {
  const n = normalizeIndustry(industry);
  if (!n) return false;
  return SENSITIVE_PATTERNS.some((p) => n.includes(p));
}
