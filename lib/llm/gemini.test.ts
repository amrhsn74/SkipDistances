import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * The SDK is stubbed, so these run with no key and no network — the same
 * property the layering exists to protect. What is tested is the wrapper's own
 * decisions: which temperature is sent, that the schema and image reach the
 * call, and that failures surface as named errors rather than raw SDK noise.
 */

const generateContent = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
    constructor(public config: { apiKey: string }) {}
  },
}));

import {
  MalformedResponseError,
  MissingApiKeyError,
  TEMPERATURE,
  generateFromImage,
  generateStructured,
  isConfigured,
  modelName,
  resetClient,
} from "./gemini";

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } } };

/** The last config the SDK was called with. */
function lastConfig() {
  return generateContent.mock.calls.at(-1)![0].config;
}
function lastRequest() {
  return generateContent.mock.calls.at(-1)![0];
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  generateContent.mockReset();
  generateContent.mockResolvedValue({ text: '{"ok":true}' });
  resetClient();
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.GEMINI_MODEL;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("temperature", () => {
  it("defaults to deterministic — the safe choice for everything but drafting", async () => {
    await generateStructured("extract the client", SCHEMA);

    // A call site that forgets to think about temperature gets the setting where
    // the same input yields the same answer, not the one that invents.
    expect(lastConfig().temperature).toBe(TEMPERATURE.deterministic);
  });

  it("keeps the deterministic preset low but not zero", () => {
    // Greedy decoding at exactly 0 can lock a model into a degenerate
    // repetition it cannot escape; the practical difference on a schema'd
    // extraction is nil.
    expect(TEMPERATURE.deterministic).toBeGreaterThan(0);
    expect(TEMPERATURE.deterministic).toBeLessThanOrEqual(0.2);
  });

  it("keeps the creative preset high enough to vary the copy", () => {
    // Five posts in a plan must read as five ideas, not one idea reworded.
    expect(TEMPERATURE.creative).toBeGreaterThanOrEqual(0.7);
    expect(TEMPERATURE.creative).toBeLessThanOrEqual(1.0);
    expect(TEMPERATURE.creative).toBeGreaterThan(TEMPERATURE.deterministic);
  });

  it("accepts a preset name", async () => {
    await generateStructured("draft five captions", SCHEMA, { temperature: "creative" });
    expect(lastConfig().temperature).toBe(TEMPERATURE.creative);

    await generateStructured("extract fields", SCHEMA, { temperature: "deterministic" });
    expect(lastConfig().temperature).toBe(TEMPERATURE.deterministic);
  });

  it("accepts an explicit number, for a call that needs its own value", async () => {
    await generateStructured("something in between", SCHEMA, { temperature: 0.4 });
    expect(lastConfig().temperature).toBe(0.4);
  });

  it("passes an explicit zero rather than treating it as unset", async () => {
    // `0` is falsy. A `||` default here would silently replace a deliberate 0
    // with 0.1 -- the kind of bug that never surfaces as an error.
    await generateStructured("exact", SCHEMA, { temperature: 0 });
    expect(lastConfig().temperature).toBe(0);
  });
});

describe("generateStructured", () => {
  it("sends the prompt, the schema and JSON mode", async () => {
    await generateStructured("what client is this brief for?", SCHEMA);

    const req = lastRequest();
    expect(req.contents[0].parts[0]).toEqual({ text: "what client is this brief for?" });
    expect(req.config.responseSchema).toBe(SCHEMA);
    // Without this the model returns prose that merely looks like JSON.
    expect(req.config.responseMimeType).toBe("application/json");
  });

  it("parses the response into the caller's type", async () => {
    generateContent.mockResolvedValue({ text: '{"client_id":"CL-101","items":3}' });

    const result = await generateStructured<{ client_id: string; items: number }>(
      "extract",
      SCHEMA,
    );

    expect(result).toEqual({ client_id: "CL-101", items: 3 });
  });

  it("sends no image part when none is given", async () => {
    await generateStructured("text only", SCHEMA);
    expect(lastRequest().contents[0].parts).toHaveLength(1);
  });

  it("passes a system instruction only when there is one", async () => {
    await generateStructured("p", SCHEMA);
    expect(lastConfig().systemInstruction).toBeUndefined();

    await generateStructured("p", SCHEMA, { systemInstruction: "You are a copywriter." });
    expect(lastConfig().systemInstruction).toBe("You are a copywriter.");
  });

  it("passes a token cap only when one is set", async () => {
    await generateStructured("p", SCHEMA);
    expect(lastConfig().maxOutputTokens).toBeUndefined();

    await generateStructured("p", SCHEMA, { maxOutputTokens: 2048 });
    expect(lastConfig().maxOutputTokens).toBe(2048);
  });
});

describe("generateFromImage", () => {
  it("attaches the image after the prompt", async () => {
    await generateFromImage("what is in this reference?", SCHEMA, "BASE64DATA");

    const parts = lastRequest().contents[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ text: "what is in this reference?" });
    expect(parts[1]).toEqual({
      inlineData: { mimeType: "image/jpeg", data: "BASE64DATA" },
    });
  });

  it("honours a PNG mime type", async () => {
    await generateFromImage("p", SCHEMA, "DATA", { imageMimeType: "image/png" });
    expect(lastRequest().contents[0].parts[1].inlineData.mimeType).toBe("image/png");
  });

  it("keeps the same schema guarantees as the text path", async () => {
    // An image is context, not an escape from structure.
    await generateFromImage("p", SCHEMA, "DATA");
    expect(lastConfig().responseSchema).toBe(SCHEMA);
    expect(lastConfig().responseMimeType).toBe("application/json");
  });
});

describe("configuration", () => {
  it("uses the default model, overridable by env", async () => {
    await generateStructured("p", SCHEMA);
    expect(lastRequest().model).toBe("gemini-3.1-flash-lite");

    process.env.GEMINI_MODEL = "gemini-3.1-pro";
    expect(modelName()).toBe("gemini-3.1-pro");
  });

  it("names a missing key clearly instead of failing as a 401 mid-pipeline", async () => {
    delete process.env.GEMINI_API_KEY;
    resetClient();

    await expect(generateStructured("p", SCHEMA)).rejects.toThrow(MissingApiKeyError);
    expect(isConfigured()).toBe(false);

    // Nothing was sent -- the failure is local, not a wasted round trip.
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("builds no client at import time, so keyless test runs work", () => {
    // The domain tests import files that transitively reach here. A client built
    // at module load would break them for want of a key they never needed.
    delete process.env.GEMINI_API_KEY;
    expect(() => isConfigured()).not.toThrow();
    expect(() => modelName()).not.toThrow();
  });
});

describe("failures", () => {
  it("surfaces unparseable output as its own error, keeping the raw text", async () => {
    generateContent.mockResolvedValue({ text: "I'm sorry, I can't help with that." });

    // A bare SyntaxError twenty frames deep gives a caller nothing to act on.
    await expect(generateStructured("p", SCHEMA)).rejects.toThrow(MalformedResponseError);

    try {
      await generateStructured("p", SCHEMA);
    } catch (e) {
      expect((e as MalformedResponseError).raw).toContain("I'm sorry");
    }
  });

  it("treats an empty response as malformed rather than as empty data", async () => {
    generateContent.mockResolvedValue({ text: undefined });
    await expect(generateStructured("p", SCHEMA)).rejects.toThrow(MalformedResponseError);
  });

  it("lets a transport error through untouched", async () => {
    // Rate limits and outages are the caller's to retry; wrapping them would
    // hide the status the caller needs to decide.
    generateContent.mockRejectedValue(new Error("429 RESOURCE_EXHAUSTED"));
    await expect(generateStructured("p", SCHEMA)).rejects.toThrow("429 RESOURCE_EXHAUSTED");
  });
});
