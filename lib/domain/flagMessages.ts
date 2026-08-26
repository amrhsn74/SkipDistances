import type { AnyFlagType } from "./misuse";

/**
 * What a flag means, in a sentence a person can act on.
 *
 * Every flag in the product is shown somewhere -- to a creator mid-thread, to an
 * account manager on a queue row, to the Admin in governance. Until now each of
 * those screens wrote its own wording, so the same `brand_violation` read as
 * "That reached a rule I cannot draft past" in chat, as a bare clause code on a
 * card, and as nothing at all in the Admin's list. A creator who saw two of
 * those had no way to tell they were the same event.
 *
 * So the wording lives here, once, and every screen renders it.
 *
 * Two rules the phrasing follows, both deliberate:
 *
 *   1. **Say what happened, not what was violated.** "This breaks CR.4" tells a
 *      creator nothing they can do. "Cairo Roast does not allow discounts, so
 *      this could not be drafted" tells them what to change.
 *   2. **Never blame the person for a content flag.** A brand violation is the
 *      engine declining to write something, not an accusation -- the creator
 *      asked for something ordinary and a rule got in the way. Governance flags
 *      are the opposite and are worded as conduct, because that is what they
 *      are and the Admin needs to read them as such.
 *
 * Pure: no database, no React. The clause text is passed in by whoever has it.
 */

/** The audience a message is written for. */
export type FlagAudience =
  /** The creator or account manager looking at their own work. */
  | "author"
  /** The Agency Admin reading the governance queue. */
  | "admin";

export type FlagContext = {
  /** The clause code, where the flag cites one. */
  clauseCode?: string | null;
  /** The clause's own title, e.g. "Don't. Never discount". */
  clauseTitle?: string | null;
  /** The client the work was for. */
  clientName?: string | null;
  /** The engine's own reason, where it gave one. */
  reason?: string | null;
};

/**
 * What each flag type means to the person who produced the work.
 *
 * Written as an explanation of the outcome rather than as a label, because the
 * reader's next question is always "so what do I do" -- and a label answers it
 * with nothing.
 */
const AUTHOR_MEANING: Record<AnyFlagType, string> = {
  brand_violation:
    "This goes against the client's own brand guide, so it was not drafted.",
  compliance_violation:
    "This breaks one of the agency's compliance rules, so it was not drafted.",
  unknown_client: "This names a client who is not on the roster, so nothing was drafted for them.",
  inactive_client: "This client is not active, so nothing can be drafted for them right now.",
  approval_override_attempt:
    "This asked to skip or fake an approval. The work can still be drafted, but it cannot be scheduled without both reviews.",
  role_boundary_violation: "This action is not one your role holds.",
  cross_client_data: "This reached for another client's information, which is never shared.",
  off_task_generation: "This was not about producing content for this client.",
  approval_churn: "This item has been declined several times — worth a conversation rather than another edit.",
};

/** The same events, read as conduct. The Admin's queue. */
const ADMIN_MEANING: Record<AnyFlagType, string> = {
  brand_violation: "Content was submitted that breaks the client's brand guide.",
  compliance_violation: "Content was submitted that breaks an agency compliance rule.",
  unknown_client: "A brief named a client who is not on the roster.",
  inactive_client: "A brief named an inactive client.",
  approval_override_attempt: "A brief tried to skip or fake an approval.",
  role_boundary_violation: "Someone attempted an action their role does not hold.",
  cross_client_data: "An attempt to reach another client's data.",
  off_task_generation: "The engine was prompted for something unrelated to the client.",
  approval_churn: "An item has been declined repeatedly — a process signal, not a breach.",
};

/**
 * A readable sentence for one flag.
 *
 * The clause is named *after* the explanation rather than before it. A reader
 * who leads with "CR.4" has to go and look it up before the sentence means
 * anything; a reader who leads with what happened can use the code to check the
 * wording afterwards, which is the order the information is actually needed in.
 */
export function flagMessage(
  flagType: string,
  context: FlagContext = {},
  audience: FlagAudience = "author",
): string {
  const table = audience === "admin" ? ADMIN_MEANING : AUTHOR_MEANING;
  const meaning = table[flagType as AnyFlagType] ?? "This was flagged for a human to look at.";

  const parts: string[] = [];

  // The client is named for the author, who works across several and needs to
  // know whose rule this was. The Admin's row already names the campaign.
  if (audience === "author" && context.clientName && isBrandScoped(flagType)) {
    parts.push(
      meaning.replace("the client's own brand guide", `${context.clientName}'s brand guide`),
    );
  } else {
    parts.push(meaning);
  }

  if (context.reason) parts.push(context.reason);

  const clause = citation(context);
  if (clause) parts.push(clause);

  return parts.join(" ");
}

/** Only the brand-guide flag is worth naming a client on. */
function isBrandScoped(flagType: string): boolean {
  return flagType === "brand_violation";
}

/**
 * The clause, as a trailing citation.
 *
 * The title is included where it is known because a code alone is not readable
 * -- "Clause CR.4 (Never discount)" is a sentence a creator can act on, and
 * "Clause CR.4" is a lookup task.
 */
function citation(context: FlagContext): string | null {
  if (!context.clauseCode) return null;
  const title = context.clauseTitle?.trim();
  return title ? `(Clause ${context.clauseCode} — ${title}.)` : `(Clause ${context.clauseCode}.)`;
}
