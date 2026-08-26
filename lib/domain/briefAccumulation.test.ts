import { describe, it, expect } from "vitest";

import {
  foldExtractions,
  nextQuestion,
  toBriefText,
  type TurnExtraction,
} from "./briefAccumulation";

/**
 * The fold is what keeps Clause 0.5 alive on the chat path, so these tests are
 * really about one property: nothing is ever guessed. A field is present because
 * someone said it, or it is missing and becomes a question.
 */

describe("folding turns into a brief", () => {
  it("accumulates fields stated across separate turns", () => {
    const turns: TurnExtraction[] = [
      { client: "Cairo Roast", objective: null, audience: null, channels: null },
      { client: null, objective: "launch the cold brew", audience: null, channels: null },
      { client: null, objective: null, audience: "office workers", channels: null },
      { client: null, objective: null, audience: null, channels: "instagram" },
    ];

    const result = foldExtractions(turns);

    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.fields).toEqual({
      client: "Cairo Roast",
      objective: "launch the cold brew",
      audience: "office workers",
      channels: "instagram",
    });
  });

  it("reports what is still missing, in the clause's own order", () => {
    const result = foldExtractions([
      { client: "Cairo Roast", objective: null, audience: null, channels: "instagram" },
    ]);

    expect(result.complete).toBe(false);
    // Clause 0.5 names client, objective, audience, channels -- in that order.
    expect(result.missing).toEqual(["objective", "audience"]);
  });

  it("treats a thread that states nothing as missing all four", () => {
    const result = foldExtractions([
      { client: null, objective: null, audience: null, channels: null },
    ]);

    expect(result.missing).toEqual(["client", "objective", "audience", "channels"]);
    expect(result.complete).toBe(false);
  });

  it("lets a later turn correct an earlier one", () => {
    const result = foldExtractions([
      { client: null, objective: null, audience: "students", channels: null },
      { client: null, objective: null, audience: "new mums", channels: null },
    ]);

    // A creator who corrects themselves has corrected themselves. Building the
    // brief from the retracted answer would be worse than asking again.
    expect(result.fields.audience).toBe("new mums");
  });

  it("does not let hesitation erase something already stated", () => {
    const result = foldExtractions([
      { client: null, objective: null, audience: "office workers", channels: null },
      { client: null, objective: null, audience: "not sure yet", channels: null },
    ]);

    // "not sure yet" is a hedge, caught by this module rather than by the
    // shared `isMissing`. Hesitation is not retraction.
    expect(result.fields.audience).toBe("office workers");
  });

  it("never lets a hedge supply a field that was never stated", () => {
    const result = foldExtractions([
      { client: "Cairo Roast", objective: "launch", audience: "not sure yet", channels: "instagram" },
    ]);

    // The hedge protects what is already there; it must never count as an
    // answer itself, or Clause 0.5 would pass on a field nobody stated.
    expect(result.missing).toEqual(["audience"]);
    expect(result.fields.audience).toBeUndefined();
  });

  it("treats placeholder answers as missing, exactly as a brief would", () => {
    // The B-013 shape: a field written out, stating nothing.
    const result = foldExtractions([
      { client: "Cairo Roast", objective: "launch", audience: "(not stated)", channels: "TBC" },
    ]);

    expect(result.missing).toEqual(["audience", "channels"]);
  });
});

describe("the next question", () => {
  it("asks for one field at a time, in the clause's order", () => {
    const result = foldExtractions([
      { client: null, objective: null, audience: null, channels: null },
    ]);

    // Not all four at once: that turns the conversation back into a form.
    expect(nextQuestion(result)).toBe("Which client is this for?");
  });

  it("returns null once nothing is missing", () => {
    const result = foldExtractions([
      { client: "Cairo Roast", objective: "launch", audience: "students", channels: "instagram" },
    ]);

    expect(nextQuestion(result)).toBeNull();
  });
});

describe("the brief handed to the engine", () => {
  it("writes the four fields as a brief, not as a transcript", () => {
    const accumulated = foldExtractions([
      { client: "Cairo Roast", objective: "launch cold brew", audience: "students", channels: "instagram" },
    ]);

    const text = toBriefText(accumulated, [
      { role: "creator", body: "something for the cold brew launch" },
      { role: "assistant", body: "Who is it speaking to?" },
      { role: "creator", body: "students, on instagram" },
    ]);

    expect(text).toContain("Client: Cairo Roast");
    expect(text).toContain("Objective: launch cold brew");
    expect(text).toContain("Audience: students");
    expect(text).toContain("Channels: instagram");
  });

  it("writes the roster code alongside the name", () => {
    const accumulated = foldExtractions([
      { client: "NileFit", objective: "launch", audience: "students", channels: "instagram" },
    ]);

    const text = toBriefText(accumulated, [], "NileFit", "CL-101");

    // `analyzeBrief` fills client_id only from a literal CL-nnn code. Writing
    // the name alone produced a brief with no code, and Clause 0.6 then flagged
    // every chat-produced campaign as "not on the roster" -- for the client the
    // thread was scoped to by construction.
    expect(text).toContain("Client: NileFit (CL-101)");
  });

  it("keeps the creator's own words, and drops the engine's", () => {
    const accumulated = foldExtractions([
      { client: "Cairo Roast", objective: "launch", audience: "students", channels: "instagram" },
    ]);

    const text = toBriefText(accumulated, [
      { role: "creator", body: "keep it playful, no exclamation marks" },
      { role: "assistant", body: "Which channels should it run on?" },
    ]);

    // The detail that never fits a field is often the whole point of the ask.
    expect(text).toContain("keep it playful, no exclamation marks");
    // The engine's own questions are not part of the brief.
    expect(text).not.toContain("Which channels should it run on?");
  });
});
