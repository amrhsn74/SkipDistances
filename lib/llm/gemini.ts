import { GoogleGenAI } from "@google/genai";

/**
 * The single chokepoint for every Gemini call.
 *
 * One file, readable top to bottom: no prompt-template abstraction and no
 * framework. Everything that decides how the model behaves — which model,
 * how deterministic, what to do when it fails — is decided here rather than at
 * each of the dozen call sites Phase 3 will add. ESLint enforces that nothing
 * else imports the SDK.
 *
 * `lib/llm` is a leaf. It knows nothing about clients, clauses or campaigns —
 * the engine assembles the prompt and validates what comes back, because a rule
 * that must never be wrong cannot live behind a network call.
 */

// --- Temperature ----------------------------------------------------------
//
// The most consequential setting here, so it is named rather than left to a
// literal at each call site.
//
// Temperature controls how much probability mass the sampler spreads beyond the
// likeliest token. It trades reproducibility for variety, and this project wants
// opposite things in different places:
//
//   - Extraction and judgment calls read a fact out of text. There is one right
//     answer, variety is pure downside, and the same brief giving two different
//     answers on two runs would make the Phase 12 evaluation meaningless.
//   - Drafting is genuinely generative. Content pinned to near-zero produces
//     stilted, repetitive copy, and a plan of five posts would read as five
//     rewordings of one.
//
// Note that low temperature buys consistency, not correctness — a confidently
// wrong extraction is still wrong. It is the engine's validation that makes an
// answer trustworthy; this only stops the answer changing under us.

export const TEMPERATURE = {
  /**
   * Extraction, classification, compliance judgment, on-task checks.
   *
   * Not 0. Greedy decoding can lock a model into a degenerate repetition it has
   * no way out of, and the practical difference from 0.1 on a well-schema'd
   * extraction is nil. This is the "read the fact out of the text" setting.
   */
  deterministic: 0.1,

  /**
   * Drafting copy — captions, hooks, photoshoot briefs.
   *
   * High enough that five items in a plan read as five ideas rather than one
   * idea reworded; low enough to stay on-brief. Compliance is enforced after
   * generation by code, so this does not need to be lowered in the hope that a
   * cooler model breaks fewer rules — that is the guarded engine's job, not the
   * sampler's.
   */
  creative: 0.9,
} as const;

export type TemperaturePreset = keyof typeof TEMPERATURE;

const DEFAULT_MODEL = "gemini-3.1-flash-lite";

/** Wrapped so a missing key is one clear error rather than a 401 mid-pipeline. */
export class MissingApiKeyError extends Error {
  readonly code = "MISSING_API_KEY";
  constructor() {
    super(
      "GEMINI_API_KEY is not set. Copy .env.example to .env and add a key from " +
        "https://aistudio.google.com/apikey — the data and domain layers run without one.",
    );
    this.name = "MissingApiKeyError";
  }
}

/** A call that came back, but not as usable JSON. */
export class MalformedResponseError extends Error {
  readonly code = "MALFORMED_RESPONSE";
  readonly raw: string;
  constructor(raw: string, cause?: unknown) {
    super(`Gemini returned a response that is not valid JSON: ${raw.slice(0, 200)}`);
    this.name = "MalformedResponseError";
    this.raw = raw;
    this.cause = cause;
  }
}

export function modelName(): string {
  return process.env.GEMINI_MODEL || DEFAULT_MODEL;
}

/**
 * Created lazily, not at module load.
 *
 * The domain layer's tests import files that transitively reach here; building a
 * client at import time would make an unset key fail those runs, when the whole
 * point of the layering is that they need no network at all.
 */
let client: GoogleGenAI | null = null;

function ai(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new MissingApiKeyError();

  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

/** Test seam: forces the next call to rebuild the client. */
export function resetClient(): void {
  client = null;
}

export type GenerateOptions = {
  /** Defaults to `deterministic` — the safe choice for everything but drafting. */
  temperature?: TemperaturePreset | number;
  /** Steering that is not part of the request itself. */
  systemInstruction?: string;
  /** A JPEG or PNG for vision input, base64-encoded without the data: prefix. */
  imageBase64?: string;
  imageMimeType?: string;
  /** Caps a runaway response. Omit to let the model decide. */
  maxOutputTokens?: number;
};

function resolveTemperature(t: GenerateOptions["temperature"]): number {
  if (t === undefined) return TEMPERATURE.deterministic;
  if (typeof t === "number") return t;
  return TEMPERATURE[t];
}

/**
 * One structured call: prompt in, schema-shaped JSON out.
 *
 * `responseSchema` makes the model emit JSON matching the shape rather than
 * prose that happens to look like it, which is what lets the engine treat the
 * result as data. It constrains *shape*, never *truth* — a schema guaranteeing a
 * `clause_id` field does not guarantee the clause is the right one, so the
 * engine still validates every value that matters against the database.
 */
export async function generateStructured<T>(
  prompt: string,
  schema: object,
  options: GenerateOptions = {},
): Promise<T> {
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];

  if (options.imageBase64) {
    parts.push({
      inlineData: {
        mimeType: options.imageMimeType ?? "image/jpeg",
        data: options.imageBase64,
      },
    });
  }

  const response = await ai().models.generateContent({
    model: modelName(),
    contents: [{ role: "user", parts }],
    config: {
      responseMimeType: "application/json",
      responseSchema: schema,
      temperature: resolveTemperature(options.temperature),
      ...(options.systemInstruction
        ? { systemInstruction: options.systemInstruction }
        : {}),
      ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
    },
  });

  const text = response.text ?? "";
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    // Surfaced as its own error so a caller can retry or flag, rather than a
    // bare SyntaxError twenty frames deep with no sign of where it came from.
    throw new MalformedResponseError(text, cause);
  }
}

/**
 * The vision path, named so a call site reads as what it is.
 *
 * Used by `P3.10` when a creator attaches a reference image. Same schema
 * guarantees as the text path — the image is context, not an escape from
 * structure.
 */
export async function generateFromImage<T>(
  prompt: string,
  schema: object,
  imageBase64: string,
  options: Omit<GenerateOptions, "imageBase64"> = {},
): Promise<T> {
  return generateStructured<T>(prompt, schema, { ...options, imageBase64 });
}

/** Whether a key is configured, for a route that must degrade rather than throw. */
export function isConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}
