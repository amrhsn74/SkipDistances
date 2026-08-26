import type { RequiredBriefField } from "./completeness";

/**
 * What the client's own brand guide already answers.
 *
 * Clause 0.5 requires the client, objective, audience and channels before
 * drafting. Two of those the guide states outright: every brand guide carries an
 * `X.2 — Audience` clause ("25-45 professionals who treat coffee as a ritual"),
 * and several name where the brand runs ("LinkedIn is the primary channel").
 *
 * Asking a creator for those is asking them to retype the guide. Worse, it
 * invites a wrong answer: a creator who types "everyone" has just overridden
 * CR.2, and Clause 0.4 requires content be written to the guide, not past it.
 *
 * So the guide is read as a *default layer* underneath the conversation. The
 * clause is not a guess -- it is the client's own written rule, and it carries
 * the clause code that says so. What the creator states still wins, because a
 * campaign may legitimately target a slice of the brand's audience; but silence
 * now resolves to the guide rather than to a question.
 *
 * Pure by design, like the rest of `lib/domain`: clauses in, fields out, no
 * database and no model. Only `audience` and `channels` are derivable this way.
 * `client` is known from the thread, and `objective` is the one thing a guide
 * can never supply -- it is what *this* campaign is for.
 */

/**
 * The clause shape this module needs.
 *
 * Structural rather than an import of `ScopedClause`, so the fold stays free of
 * anything that reaches a database. `retrievalScope`'s rows satisfy it.
 */
export type GuideClause = {
  clause_code: string;
  title: string;
  text: string;
  source_type: "agency" | "brand";
};

/**
 * A default, with the clause it came from so a reviewer can check it.
 *
 * `clauseCode` is optional because not every known-in-advance field comes from a
 * clause: a conversation's client is known because the thread was opened against
 * it. Attributing that to a clause would put a citation in the brief that the
 * guide does not actually support, and citations here are checked.
 */
export type GuideDefault = {
  value: string;
  clauseCode?: string;
};

export type GuideDefaults = Partial<Record<RequiredBriefField, GuideDefault>>;

/**
 * Clause titles that answer a Clause 0.5 field.
 *
 * Matched on the parsed title rather than the code, because the code is
 * per-brand (`CR.2`, `NF.2`, `TN.2`) while the title is the vocabulary the
 * guides share. A new brand guide that follows the house format is picked up
 * with no change here.
 */
const AUDIENCE_TITLE = /^audience$/i;

/**
 * Channels are rarely a clause of their own; they are stated inside the audience
 * or voice clause ("Instagram and TikTok first", "LinkedIn is the primary
 * channel"). So they are read out of the clause text by name, from the set the
 * platform actually publishes to.
 */
const CHANNEL_TITLE = /^(channels?|platforms?)$/i;

const KNOWN_CHANNELS = [
  "instagram",
  "tiktok",
  "linkedin",
  "facebook",
  "youtube",
  "x",
  "twitter",
  "email",
  "whatsapp",
  "web",
] as const;

/**
 * Word boundary, so "x" does not match inside "extra" and "web" does not match
 * inside "website".
 */
const BOUND = "\\b";

/** Channel names appearing in a clause, in the order the clause names them. */
function channelsIn(text: string): string[] {
  const found: { name: string; at: number }[] = [];

  for (const channel of KNOWN_CHANNELS) {
    const at = text.search(new RegExp(BOUND + channel + BOUND, "i"));
    if (at >= 0) found.push({ name: channel, at });
  }

  return found.sort((a, b) => a.at - b.at).map((f) => f.name);
}

/**
 * Read a client's guide clauses into Clause 0.5 defaults.
 *
 * Brand clauses only. Agency standards govern every client and say nothing
 * about who a particular brand speaks to -- reading a default out of them would
 * make one client's brief quietly depend on another's rules, which is precisely
 * what Clause 0.7 scoping exists to prevent.
 */
export function guideDefaults(clauses: GuideClause[]): GuideDefaults {
  const brand = clauses.filter((c) => c.source_type === "brand");
  const defaults: GuideDefaults = {};

  const audience = brand.find((c) => AUDIENCE_TITLE.test(c.title));
  if (audience) {
    defaults.audience = {
      value: stripTitle(audience.text, audience.title),
      clauseCode: audience.clause_code,
    };
  }

  // A dedicated channels clause wins; otherwise the channels named inside the
  // audience clause, which is where the guides in fact put them.
  const channelClause = brand.find((c) => CHANNEL_TITLE.test(c.title));
  if (channelClause) {
    defaults.channels = {
      value: stripTitle(channelClause.text, channelClause.title),
      clauseCode: channelClause.clause_code,
    };
  } else if (audience) {
    const named = channelsIn(audience.text);
    if (named.length > 0) {
      defaults.channels = { value: named.join(", "), clauseCode: audience.clause_code };
    }
  }

  return defaults;
}

/**
 * `parseGuidelines` prepends the title to the text so retrieval can see it
 * ("Audience. 25-45 professionals ..."). For a field value the title is noise,
 * so it comes back off here rather than being left out of the stored clause --
 * the retrieval step still needs it.
 */
function stripTitle(text: string, title: string): string {
  const prefix = `${title}.`;
  const stripped = text.startsWith(prefix) ? text.slice(prefix.length) : text;
  return stripped.trim();
}
