import { prisma, type Db } from "../db";
import {
  type GuidelineScope,
  type ScopedClause,
  getGuidelinesForClient,
} from "../domain/retrievalScope";

/**
 * Step 5: the rules this client's content is drafted under.
 *
 * A thin wrapper. The double-scoped query that makes cross-client leakage
 * structurally impossible is Phase 2's, and is tested there. What lives here is
 * the part that is about *prompting*: rendering clauses so the model can cite
 * them, and refusing to hand over a corpus that would not fit.
 *
 * The retrieval itself is the guarantee. The model is never given the corpus to
 * hold — it gets one client's clauses, fetched per request, and every draft must
 * name the clause it was written under. A model cannot leak a guide it was never
 * shown.
 */

export type { GuidelineScope, ScopedClause };

/**
 * Ceiling on how much clause text reaches one prompt.
 *
 * The seeded corpus is 20 agency clauses plus at most 8 brand clauses per
 * client, which is nowhere near this. The cap exists so that a future guide
 * three times the size degrades visibly — a truncated prompt that silently drops
 * the clause a draft needed is the worst possible failure here, so truncation is
 * reported rather than done quietly.
 */
export const MAX_CLAUSE_CHARS = 60_000;

export type GuidelineBundle = GuidelineScope & {
  /** Clause codes in the order they were rendered, for validating citations. */
  availableCodes: string[];
  /** True when the corpus exceeded the cap and some clauses were left out. */
  truncated: boolean;
  omittedCodes: string[];
};

/**
 * Fetch the clauses governing one client.
 *
 * Agency standards apply to everyone, including the 142 clients with no brand
 * guide of their own; brand clauses are scoped to this client's active guide
 * version. A client with no guide is governed by agency standards alone — a
 * normal case, not a degraded one.
 */
export async function searchGuidelines(
  clientId: string,
  db: Db = prisma,
  /** Overridable so the truncation path is testable against real clauses --
   *  the seeded corpus never approaches the real cap. */
  maxChars: number = MAX_CLAUSE_CHARS,
): Promise<GuidelineBundle> {
  const scope = await getGuidelinesForClient(clientId, db);

  const kept: ScopedClause[] = [];
  const omittedCodes: string[] = [];
  let budget = maxChars;

  // Agency clauses come first in `all`, and are kept first on purpose: if
  // anything has to go, it must not be the compliance rules that govern every
  // client. Brand voice is what a plan can afford to lose.
  for (const clause of scope.all) {
    const cost = clause.text.length + clause.title.length;
    if (cost > budget) {
      omittedCodes.push(clause.clause_code);
      continue;
    }
    budget -= cost;
    kept.push(clause);
  }

  return {
    ...scope,
    agency: kept.filter((c) => c.source_type === "agency"),
    brand: kept.filter((c) => c.source_type === "brand"),
    all: kept,
    availableCodes: kept.map((c) => c.clause_code),
    truncated: omittedCodes.length > 0,
    omittedCodes,
  };
}

/**
 * Render clauses for a prompt.
 *
 * The clause code leads every entry, because the code is what a draft must cite
 * and what the Phase 12 evaluation grades against. Burying it after the text
 * invites the model to cite by title, which is not a vocabulary anything else
 * understands.
 */
export function formatGuidelinesForPrompt(bundle: GuidelineBundle): string {
  const section = (label: string, clauses: ScopedClause[]) => {
    if (clauses.length === 0) return null;
    const body = clauses
      .map((c) => `[${c.clause_code}] ${c.title}\n${c.text}`)
      .join("\n\n");
    return `## ${label}\n\n${body}`;
  };

  const parts = [
    section("Agency standards — apply to every client", bundle.agency),
    section("Brand guidelines — this client only", bundle.brand),
  ].filter(Boolean);

  if (parts.length === 0) {
    // Should be unreachable: agency clauses govern everyone. Said plainly rather
    // than returning "" so a broken retrieval is visible in the prompt instead
    // of looking like a client with no rules.
    return "No guidelines were retrieved. Do not draft; report this as a retrieval failure.";
  }

  if (bundle.brand.length === 0) {
    parts.push(
      "## Brand guidelines\n\nThis client has no brand guide on file. Agency " +
        "standards govern alone — do not infer a house style, and cite only the " +
        "agency clauses above.",
    );
  }

  return parts.join("\n\n");
}

/**
 * Whether a clause code the model cited was actually retrieved.
 *
 * The check that makes citation mean something. A model asked to cite a clause
 * will happily produce a plausible-looking code it never saw — `NF.9` for a
 * client whose guide stops at `NF.5`. Every citation is validated against what
 * was retrieved, never taken on trust.
 */
export function isCitable(bundle: GuidelineBundle, clauseCode: string): boolean {
  return bundle.availableCodes.includes(clauseCode);
}

/** Codes cited that were never retrieved — a hallucinated citation. */
export function uncitableCodes(bundle: GuidelineBundle, cited: string[]): string[] {
  return cited.filter((code) => !isCitable(bundle, code));
}
