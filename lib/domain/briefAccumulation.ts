import {
  REQUIRED_BRIEF_FIELDS,
  isMissing,
  type RequiredBriefField,
} from "./completeness";

/**
 * Folding a conversation into a brief.
 *
 * This is the module that keeps Clause 0.5 alive on the chat path, and the way
 * it does that is worth stating plainly, because the obvious implementation
 * would quietly destroy the rule.
 *
 * A brief is complete when it states the client, the objective, the audience and
 * the channels. On the brief path a missing field returns REQUEST_INFO and the
 * account manager is told what to supply. A conversation cannot work that way --
 * nobody types all four in their first message, and returning REQUEST_INFO to
 * someone who has said one sentence would make the product unusable.
 *
 * So the same check is asked as a *question* instead of returned as a
 * rejection. The fold below accumulates what the exchange has established so
 * far; whatever is still missing becomes what the engine asks next. Nothing is
 * guessed, nothing is defaulted, and generation is not reachable until all four
 * are actually present -- which is exactly what the clause requires. The rule is
 * unchanged; only its presentation is.
 *
 * Pure by design. It takes turns and returns fields, so the rule that decides
 * whether work may begin can be unit-tested without a database or a model.
 */

/**
 * Hedging, as people actually type it in a conversation.
 *
 * Deliberately *not* added to `completeness.isMissing`, which is shared with the
 * brief path and whose behaviour `answer_key.json` grades. A brief that writes
 * "not sure yet" into its audience field is a different artefact from someone
 * saying it mid-sentence, and widening the shared rule to catch the second would
 * quietly change how the first is judged.
 *
 * This list only ever protects information already given: a hedge never
 * overwrites a stated value, and never supplies one.
 */
const HEDGE_PATTERNS = [
  /^\(?\s*not\s+sure(\s+yet)?\s*\)?$/i,
  /^\(?\s*(i\s+)?don'?t\s+know\s*\)?$/i,
  /^\(?\s*no\s+idea\s*\)?$/i,
  /^\(?\s*maybe\s*\)?$/i,
  /^\(?\s*undecided\s*\)?$/i,
  /^\(?\s*open\s*\)?$/i,
];

/** True when a value states nothing -- absent, blank, placeholder, or a hedge. */
function statesNothing(value: string | null | undefined): boolean {
  if (isMissing(value)) return true;
  return HEDGE_PATTERNS.some((pattern) => pattern.test((value as string).trim()));
}

/** A turn as this module needs to see it. */
export type FoldableTurn = {
  role: string;
  body: string;
};

/**
 * What the conversation has established.
 *
 * `fields` carries only what was actually stated. `missing` is the complement,
 * in the order Clause 0.5 names them, so the question asked next follows the
 * clause's own priority rather than whatever order a map happened to iterate.
 */
export type AccumulatedBrief = {
  fields: Partial<Record<RequiredBriefField, string>>;
  missing: RequiredBriefField[];
  complete: boolean;
};

/**
 * What the model is asked to extract, turn by turn.
 *
 * Every field nullable, for the same reason `analyzeBrief`'s schema is: a schema
 * that requires `audience` forces the model to invent one, and an invented
 * audience is precisely the guess Clause 0.5 forbids.
 */
export type TurnExtraction = Partial<Record<RequiredBriefField, string | null>>;

/**
 * Fold per-turn extractions into one brief.
 *
 * Later turns win. A creator who says "actually, make it for new mums, not
 * students" has corrected themselves, and the fold has to reflect that or the
 * brief would be built from something they explicitly retracted.
 *
 * A null or placeholder value never overwrites a stated one, though: "not sure
 * yet" after naming an audience is hesitation, not retraction, and treating it
 * as an erasure would drop information the creator had already given.
 */
export function foldExtractions(extractions: TurnExtraction[]): AccumulatedBrief {
  const fields: Partial<Record<RequiredBriefField, string>> = {};

  for (const extraction of extractions) {
    for (const field of REQUIRED_BRIEF_FIELDS) {
      const value = extraction[field];
      // A hedge is not a retraction. "not sure yet" after naming an audience is
      // hesitation, and treating it as an erasure would drop what the creator
      // had already told us.
      if (statesNothing(value)) continue;
      fields[field] = (value as string).trim();
    }
  }

  const missing = REQUIRED_BRIEF_FIELDS.filter((field) => statesNothing(fields[field]));

  return { fields, missing, complete: missing.length === 0 };
}

/**
 * The brief text handed to the engine once the fold is complete.
 *
 * Written as a brief rather than as a transcript on purpose. `analyzeBrief` is
 * built to read a brief, and it is the same function the account manager's path
 * uses -- feeding it a raw chat log would make the two paths behave differently
 * at the very first step, which is the thing this whole phase is trying not to
 * do.
 *
 * The creator's own words are appended below the four fields, because the
 * details that never fit a field -- a tone, a reference, a constraint -- are
 * often the whole point of what they asked for, and `analyzeBrief` reads them
 * into `notes` where generation can use them.
 */
export function toBriefText(
  accumulated: AccumulatedBrief,
  turns: FoldableTurn[],
  /**
   * The conversation's own client, which outranks anything the turns said.
   *
   * A thread is opened for one client and stays with it. If a creator writes
   * "actually, make this for NileFit" in a Cairo Roast thread, the brief must
   * still say Cairo Roast -- the campaign row is filed against the thread's
   * client, and a brief naming a different one would put `resolveClient` and
   * the campaign row into disagreement. `queueOrFlag` refuses that outright,
   * which would surface as a crash rather than as the cross-client refusal it
   * actually is.
   *
   * The creator's words are still carried below, so an attempt to switch client
   * is visible to a reviewer rather than silently erased.
   */
  clientName?: string | null,
  /**
   * The roster code, written into the brief alongside the name.
   *
   * `analyzeBrief` fills `client_id` only when a literal CL-nnn code appears in
   * the text -- deliberately, since deciding *which* client a name refers to is
   * `resolveClient`'s job, not an extractor's guess. The account manager's path
   * satisfies that because they paste briefs that carry the code.
   *
   * A conversation does not: it is opened against a client id, and the creator
   * then talks about the brand by name. Writing only the name produced a brief
   * with no code, so `client_id` came back null and Clause 0.6 flagged every
   * chat-produced campaign as "not on the roster" -- for a client the thread was
   * scoped to by construction.
   *
   * So the code is stated, because here it is known rather than inferred. This
   * narrows nothing: `resolveClient` still resolves it against the roster and
   * still flags an unknown or inactive client, exactly as before.
   */
  clientId?: string | null,
): string {
  const lines = [
    `Client: ${[clientName ?? accumulated.fields.client ?? "", clientId ? `(${clientId})` : ""]
      .filter(Boolean)
      .join(" ")}`,
    `Objective: ${accumulated.fields.objective ?? ""}`,
    `Audience: ${accumulated.fields.audience ?? ""}`,
    `Channels: ${accumulated.fields.channels ?? ""}`,
  ];

  const said = turns
    .filter((turn) => turn.role === "creator")
    .map((turn) => turn.body.trim())
    .filter(Boolean);

  if (said.length > 0) {
    lines.push("", "Notes from the creator:", ...said.map((s) => `- ${s}`));
  }

  return lines.join("\n");
}

/**
 * The question to ask next.
 *
 * One field at a time, in the clause's order. Asking for all four at once turns
 * a conversation back into a form, which is the thing the creator came here to
 * avoid -- and a creator who is told four things are missing tends to answer the
 * first and forget the rest.
 */
export function nextQuestion(accumulated: AccumulatedBrief): string | null {
  const [next] = accumulated.missing;
  if (!next) return null;
  return QUESTIONS[next];
}

const QUESTIONS: Record<RequiredBriefField, string> = {
  client: "Which client is this for?",
  objective: "What should this campaign achieve?",
  audience: "Who is it speaking to?",
  channels: "Which channels should it run on?",
};
