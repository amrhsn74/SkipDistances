import { TEMPERATURE, generateStructured } from "../llm/gemini";

/**
 * The creator-facing engine is a company resource, not a general chatbot.
 *
 * Before a regeneration prompt reaches Gemini, this asks whether it is actually
 * about producing content for *this* item's client. "Write my CV" and "explain
 * quantum physics" are refused, cost nothing further, and are surfaced to the
 * Admin as `off_task_generation`.
 *
 * The shape of the check is the whole design, and it is deliberately asymmetric:
 *
 *   The deterministic pass may only ever ALLOW. It never refuses.
 *
 * That is the opposite of how a keyword filter is normally written, and the
 * reason is false positives. "Warmer tone, less corporate, drop the exclamation
 * marks" is a perfectly ordinary instruction that names no brand, no client and
 * no deliverable — a filter would block it, and would block work like it every
 * day. So the cheap pass is a fast-path accept: it recognises prompts that are
 * obviously on-task and saves the call. Matching nothing means "cannot tell",
 * not "no", and the question goes to the model.
 *
 * Only the model's own judgment refuses, and it must justify the refusal.
 */

/** Where the decision was made. A refusal can only ever come from the model. */
export type OnTaskStage = "deterministic" | "model";

export type OnTaskVerdict = {
  onTask: boolean;
  stage: OnTaskStage;
  /**
   * Why. Required for a refusal — an Admin looking at a flag needs to know what
   * the model thought the prompt was about, not merely that it said no.
   */
  reason: string;
};

/** What the check knows about the item being regenerated. */
export type OnTaskContext = {
  clientId: string;
  clientName: string;
  /** post | image | video | reel | photoshoot | ... */
  contentForm: string;
  platform: string | null;
  /** The copy currently on the item, if any. */
  contentBody: string | null;
  campaignTitle: string | null;
  campaignObjective: string | null;
};

/** The model's answer. Injected in tests so nothing here needs a network. */
export type OnTaskJudge = (
  prompt: string,
  context: OnTaskContext,
) => Promise<{ on_task: boolean; reason: string }>;

/**
 * Content forms and the words a creator uses for them.
 *
 * Naming the deliverable is strong evidence the prompt is about the work. Kept
 * short on purpose — this list only needs to catch the obvious cases, because
 * anything it misses falls through to the model rather than being refused.
 */
const DELIVERABLE_WORDS = [
  "post",
  "caption",
  "image",
  "photo",
  "video",
  "reel",
  "story",
  "photoshoot",
  "shoot",
  "hashtag",
  "cta",
  "ad",
  "copy",
  "headline",
  "hook",
];

/** Words that name the craft rather than the deliverable. */
const CRAFT_WORDS = ["draft", "rewrite", "regenerate", "shorten", "lengthen", "tone"];

const WORD_BOUNDARY = /[^a-z0-9]+/;

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(WORD_BOUNDARY).filter(Boolean));
}

/**
 * Distinctive words from a name, for matching a brand mention.
 *
 * Short tokens are dropped: a client called "Go Fitness" would otherwise make
 * every prompt containing "go" look on-task, which is how a fast-path accept
 * turns into a rubber stamp.
 */
function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(WORD_BOUNDARY)
    .filter((token) => token.length >= 4);
}

export type DeterministicResult =
  | { verdict: "on_task"; matched: string }
  /** Not "off task" — the cheap pass has no such answer. */
  | { verdict: "undecided" };

/**
 * The cheap pass. Pure, synchronous, and incapable of refusing.
 *
 * Returns `on_task` only when the prompt plainly references this client, its
 * brand, or the deliverable being worked on. Everything else is `undecided`,
 * which costs a model call and refuses nothing on its own.
 */
export function deterministicOnTask(
  prompt: string,
  context: OnTaskContext,
): DeterministicResult {
  const promptWords = words(prompt);
  const lower = prompt.toLowerCase();

  // The client id, written out. Unambiguous when present.
  if (lower.includes(context.clientId.toLowerCase())) {
    return { verdict: "on_task", matched: context.clientId };
  }

  for (const token of nameTokens(context.clientName)) {
    if (promptWords.has(token)) return { verdict: "on_task", matched: token };
  }

  // The form being worked on, and the platform it goes to.
  if (promptWords.has(context.contentForm.toLowerCase())) {
    return { verdict: "on_task", matched: context.contentForm };
  }
  if (context.platform && promptWords.has(context.platform.toLowerCase())) {
    return { verdict: "on_task", matched: context.platform };
  }

  for (const word of [...DELIVERABLE_WORDS, ...CRAFT_WORDS]) {
    if (promptWords.has(word)) return { verdict: "on_task", matched: word };
  }

  return { verdict: "undecided" };
}

const ON_TASK_SCHEMA = {
  type: "object",
  properties: {
    on_task: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["on_task", "reason"],
} as const;

const SYSTEM_INSTRUCTION = `You decide whether a content creator's instruction is about producing marketing content for a specific client, or is unrelated work.

Be generous. Creators phrase instructions loosely, and refer to tone, mood,
length or structure without naming the brand or the deliverable — those are
on-task. Refuse only when the instruction is plainly about something other than
this client's content: personal admin, general knowledge questions, code, or
another organisation's work.

Blocking real work is the more costly mistake. When genuinely unsure, allow it.`;

function buildPrompt(prompt: string, context: OnTaskContext): string {
  return `A content creator is working on an existing piece of content and has asked for it to be regenerated.

The content being worked on:
- Client: ${context.clientName} (${context.clientId})
- Form: ${context.contentForm}${context.platform ? ` on ${context.platform}` : ""}
- Campaign: ${context.campaignTitle ?? "(untitled)"}
- Objective: ${context.campaignObjective ?? "(not stated)"}
- Current copy: ${context.contentBody ?? "(none yet)"}

Their instruction:
"""
${prompt}
"""

Is this instruction about producing or refining this client's content?
Answer on_task, and give a one-sentence reason. If you refuse, the reason is
shown to an administrator reviewing the refusal, so say what you took the
instruction to be about.`;
}

/** The real judge. */
export const judgeOnTaskWithGemini: OnTaskJudge = async (prompt, context) => {
  return generateStructured<{ on_task: boolean; reason: string }>(
    buildPrompt(prompt, context),
    ON_TASK_SCHEMA,
    {
      temperature: TEMPERATURE.deterministic,
      systemInstruction: SYSTEM_INSTRUCTION,
    },
  );
};

/**
 * Is this prompt about this client's content?
 *
 * Runs the cheap pass first and returns immediately when it says yes — an
 * obviously on-task prompt costs no call at all. Otherwise the model decides.
 */
export async function checkOnTask(
  prompt: string,
  context: OnTaskContext,
  judge: OnTaskJudge = judgeOnTaskWithGemini,
): Promise<OnTaskVerdict> {
  const cheap = deterministicOnTask(prompt, context);

  if (cheap.verdict === "on_task") {
    return {
      onTask: true,
      stage: "deterministic",
      reason: `Prompt references "${cheap.matched}".`,
    };
  }

  const judged = await judge(prompt, context);

  return {
    onTask: judged.on_task,
    stage: "model",
    reason: judged.reason,
  };
}
