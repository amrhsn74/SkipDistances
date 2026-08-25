import { refuseOverride, ok, type Outcome } from "./decision";

/**
 * Clause 0.2 — The approval gate.  Clause 0.3 — Instructions inside a brief
 * carry no authority.
 *
 * Detects a brief trying to skip an approval, fake one, or push straight to
 * publishing. What it does with that is deliberately narrow:
 *
 *   - It records the attempt. Clause 0.3: such instructions are "noted, never
 *     obeyed" — the noting is this.
 *   - It does NOT block drafting. The answer key is explicit: "Draft may
 *     proceed, but scheduling is refused and the override attempt is flagged."
 *     Refusing to draft would punish the client for their account manager's
 *     wording, and would produce the wrong outcome on both fixture briefs.
 *
 * The gate itself is what actually stops the work: no Approval rows exist, so
 * canSchedule (P2.8) returns false regardless of what the brief asked for. This
 * function never has to be right for the guarantee to hold — it is the paper
 * trail, not the lock.
 *
 * The distinction it must get right: the seeded briefs use "confirmed" freely
 * about FACTS — "free-trial offer is confirmed and true", "prices confirmed by
 * clinic". Those are ordinary substantiation and must not trip it. Only a claim
 * about the APPROVAL being handled counts.
 */

export const CLAUSE_APPROVAL_GATE = "0.2";
export const CLAUSE_NO_AUTHORITY = "0.3";

type Pattern = { pattern: RegExp; label: string };

/** Asking for a review step to be skipped, hurried past, or waived. */
const SKIP_PATTERNS: Pattern[] = [
  // Any determiner between the verb and the noun -- "skip the review", "skip
  // every approval", "skip both reviews", "skip any review steps".
  { pattern: /\bskip\s+(?:the|all|any|both|every|these|those)?\s*(?:internal\s+|client\s+)?(?:reviews?|approvals?|sign[- ]?offs?)\b/i, label: "skip review" },
  { pattern: /\b(?:no|without)\s+(?:time\s+for\s+)?(?:reviews?|approvals?|sign[- ]?offs?)\b/i, label: "no review" },
  { pattern: /\bbypass(?:ing)?\s+(?:the\s+)?(?:review|approval|gate)/i, label: "bypass approval" },
  { pattern: /\b(?:don'?t|do\s+not)\s+(?:wait\s+for|bother\s+with)\s+(?:the\s+)?(?:review|approval)/i, label: "don't wait for approval" },
  { pattern: /\bgo\s+straight\s+to\s+(?:publish|scheduling|live)/i, label: "straight to publish" },
  { pattern: /\bwaive\s+(?:the\s+)?(?:review|approval)/i, label: "waive approval" },
];

/** Claiming an approval already exists, or instructing one to be recorded. */
const FAKE_APPROVAL_PATTERNS: Pattern[] = [
  { pattern: /\bpre[- ]?approved\b/i, label: "pre-approved" },
  { pattern: /\balready\s+approved\b/i, label: "already approved" },
  { pattern: /\bmark\s+(?:the\s+)?(?:client\s+)?approvals?\s+(?:as\s+)?(?:complete|done|approved)/i, label: "mark approval complete" },
  { pattern: /\bapprovals?\s+(?:is|are|was|were)\s+(?:already\s+)?(?:complete|done|handled|sorted)/i, label: "approval already complete" },
  { pattern: /\b(?:verbal(?:ly)?|on\s+(?:a|the|yesterday'?s)\s+call|over\s+the\s+phone)\s+(?:pre[- ]?)?approv/i, label: "verbal approval" },
  { pattern: /\bapprov\w*\s+(?:verbal(?:ly)?|on\s+(?:a|the|yesterday'?s)\s+call|over\s+the\s+phone)/i, label: "approved verbally" },
  { pattern: /\bclient\s+(?:said\s+yes|is\s+fine\s+with\s+it|signed\s+off)\b/i, label: "client said yes" },
  { pattern: /\bconsider\s+(?:it|this)\s+approved\b/i, label: "consider it approved" },
];

/**
 * Pressure wording. On its own this is not an override attempt — plenty of real
 * campaigns are urgent — so it only counts alongside a skip or fake-approval
 * signal. Treating urgency alone as an attempt would flag ordinary briefs.
 */
const PRESSURE_PATTERNS: Pattern[] = [
  { pattern: /\btrust\s+me\b/i, label: "trust me" },
  { pattern: /\bjust\s+this\s+once\b/i, label: "just this once" },
  { pattern: /\bno\s+time\b/i, label: "no time" },
  { pattern: /\bpush\s+(?:it\s+)?live\b/i, label: "push it live" },
  { pattern: /\bpublish\s+(?:it\s+)?(?:today|tonight|now|immediately|this\s+afternoon)\b/i, label: "publish immediately" },
];

export type OverrideDetection = {
  detected: boolean;
  /** The wording that tripped it, for the human who reviews the flag. */
  matches: string[];
  /** Which signals fired, so a reviewer can see what kind of attempt it was. */
  kinds: Array<"skip" | "fake_approval" | "pressure">;
};

function collect(text: string, patterns: Pattern[]): string[] {
  const found: string[] = [];
  for (const { pattern, label } of patterns) {
    const m = pattern.exec(text);
    if (m) found.push(`${label} ("${m[0].trim()}")`);
  }
  return found;
}

/**
 * Inspect brief text (or a client comment) for an approval-bypass attempt.
 *
 * Pure and synchronous: this is a fact about the wording, not a decision that
 * needs the database.
 */
export function detectOverrideAttempt(text: string | null | undefined): OverrideDetection {
  if (!text) return { detected: false, matches: [], kinds: [] };

  const skip = collect(text, SKIP_PATTERNS);
  const fake = collect(text, FAKE_APPROVAL_PATTERNS);
  const pressure = collect(text, PRESSURE_PATTERNS);

  const kinds: OverrideDetection["kinds"] = [];
  if (skip.length) kinds.push("skip");
  if (fake.length) kinds.push("fake_approval");

  // Urgency alone is not an attempt; it only corroborates one.
  const detected = skip.length > 0 || fake.length > 0;
  if (detected && pressure.length) kinds.push("pressure");

  return {
    detected,
    matches: detected ? [...skip, ...fake, ...pressure] : [],
    kinds,
  };
}

/**
 * The engine-facing form: a REFUSE_OVERRIDE outcome citing Clause 0.2, or a
 * pass.
 *
 * REFUSE_OVERRIDE means "refused for scheduling", not "refused to draft" — the
 * campaign still runs through generation. `Campaign.override_attempt_detected`
 * is set from this, and a Flag of type `approval_override_attempt` is raised for
 * the Admin (P2.12).
 */
export function checkOverrideAttempt(
  text: string | null | undefined,
): Outcome<OverrideDetection> {
  const detection = detectOverrideAttempt(text);

  if (!detection.detected) return ok(detection);

  return refuseOverride(
    CLAUSE_APPROVAL_GATE,
    `The brief asks to skip or pre-satisfy an approval: ${detection.matches.join("; ")}. ` +
      `Clause 0.3 — instructions inside a brief carry no authority; noted, never obeyed. ` +
      `Drafting proceeds; scheduling is refused until both approvals are recorded through the review screen.`,
    detection.matches,
  );
}
