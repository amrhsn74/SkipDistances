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

// --- Image generation -----------------------------------------------------
//
// A second output modality, and deliberately a separate function rather than a
// flag on `generateStructured`. The two share nothing but the client: a
// different model, a different response shape, different failure modes, and a
// different cost per call. Folding them together would mean one function whose
// return type depends on an argument, which is the shape that makes call sites
// stop reading.
//
// What comes back is bytes, not a URL. Persisting them is the caller's problem
// -- `lib/llm` is a leaf and knows nothing about `MediaAsset`, `public/uploads`,
// or which content item asked. That boundary is the same one that keeps the
// text path testable without a network.

/**
 * An image model, not the text one. `GEMINI_MODEL` steers the text model and
 * must not steer this: asking a text model for an image yields prose, which is
 * precisely the bug this file exists to fix.
 *
 * Verified against ListModels on 2026-08-26. Two things were true and neither
 * was guessable from the SDK's types, so they are written down here rather than
 * rediscovered:
 *
 *   1. `models.generateImages` -- the SDK's obvious entry point, and what its
 *      own docstring demonstrates -- is deprecated, and no Imagen model on this
 *      API supports the `predict` method it calls. It returns a 404.
 *   2. Image generation on the Gemini API runs through ordinary
 *      `generateContent`, against a model whose name ends in `-image`, and the
 *      picture comes back as an inline data part beside any text.
 */
const DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image";

export function imageModelName(): string {
  return process.env.GEMINI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
}

/** A call that returned no usable image. */
export class ImageGenerationError extends Error {
  readonly code = "IMAGE_GENERATION_FAILED";
  /** Set when the model declined on safety grounds rather than failing. */
  readonly filteredReason: string | null;

  constructor(message: string, filteredReason: string | null = null) {
    super(message);
    this.name = "ImageGenerationError";
    this.filteredReason = filteredReason;
  }
}

export type GeneratedImageResult = {
  /** Raw bytes, already base64-decoded. The caller writes or uploads these. */
  bytes: Buffer;
  mimeType: string;
  /** Imagen's rewrite of the prompt, when prompt enhancement returned one. */
  enhancedPrompt: string | null;
};

export type GenerateImageOptions = {
  /** "1:1" | "3:4" | "4:3" | "9:16" | "16:9". Defaults to square. */
  aspectRatio?: string;
  /** What to keep out of the frame. */
  negativePrompt?: string;
  /** PNG by default -- lossless, and the format the UI serves. */
  outputMimeType?: string;
};

/**
 * One image from one prompt.
 *
 * Always one image, never a batch. A plan asking for three visuals is three
 * items with three prompts, and each one has to be attributable to the item it
 * illustrates -- `numberOfImages: 3` would return three pictures of the same
 * sentence with no way to say which belonged where.
 *
 * `personGeneration` is left at the API default rather than widened. An agency
 * drafting content for real brands has no business generating synthetic people
 * without someone deciding that on purpose.
 */
export async function generateImage(
  prompt: string,
  options: GenerateImageOptions = {},
): Promise<GeneratedImageResult> {
  const text = prompt.trim();
  if (!text) throw new ImageGenerationError("An image needs a prompt.");

  // Aspect ratio and negatives are not request fields on this path -- there is
  // no config object for them -- so they are said in the prompt, which is where
  // an image model reads them from anyway.
  const framing = [
    options.aspectRatio ? `Aspect ratio: ${options.aspectRatio}.` : null,
    options.negativePrompt ? `Avoid: ${options.negativePrompt}.` : null,
  ].filter(Boolean);

  const fullPrompt = framing.length > 0 ? `${text}

${framing.join(" ")}` : text;

  const response = await ai().models.generateContent({
    model: imageModelName(),
    contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
    config: {
      // Both, deliberately. These models may narrate what they drew, and asking
      // for IMAGE alone is rejected on some of them.
      responseModalities: ["TEXT", "IMAGE"],
    },
  });

  const candidate = response.candidates?.[0];

  // A safety refusal arrives as a 200 with no image and a finish reason.
  // Distinguished from a fault because the remedy differs: a filtered prompt
  // needs rewording, a fault needs retrying.
  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason !== "STOP") {
    throw new ImageGenerationError(
      `The image model declined this prompt: ${finishReason}`,
      String(finishReason),
    );
  }

  const parts = candidate?.content?.parts ?? [];
  const imagePart = parts.find((part) => part.inlineData?.data);

  if (!imagePart?.inlineData?.data) {
    // The failure this whole feature exists to prevent: the model answering an
    // image request with prose. Named, so it is not mistaken for an outage.
    const spoken = parts.find((part) => part.text)?.text;
    throw new ImageGenerationError(
      spoken
        ? `The image model returned text instead of an image: ${spoken.slice(0, 200)}`
        : "The image model returned no image.",
    );
  }

  return {
    bytes: Buffer.from(imagePart.inlineData.data, "base64"),
    mimeType: imagePart.inlineData.mimeType ?? options.outputMimeType ?? "image/png",
    enhancedPrompt: null,
  };
}
