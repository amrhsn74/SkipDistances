import type { TurnExtraction } from "../domain/briefAccumulation";
import { TEMPERATURE, generateStructured } from "../llm/gemini";

/**
 * What one conversation turn stated, in Clause 0.5's four fields.
 *
 * Narrower than `analyzeBrief` on purpose, and the difference is the point.
 * `analyzeBrief` reads a whole brief and extracts everything the engine needs --
 * deliverables, dates, notes, override language. This reads *one message* and
 * answers only "did they name a client, an objective, an audience, or channels
 * here". The rich extraction still happens, once, on the assembled brief text,
 * so the chat path and the brief path reach `analyzeBrief` the same way.
 *
 * Every field nullable, for the reason `analyzeBrief`'s schema gives: a schema
 * that requires `audience` forces the model to invent one, and an invented
 * audience is exactly the guess Clause 0.5 forbids. A turn that mentions none of
 * the four returns four nulls, which is the correct and common answer.
 */

/** One turn in, four possible fields out. */
export type FieldExtractor = (
  turn: string,
  /** The thread's client, where known -- so "them" and "they" resolve. */
  clientName: string | null,
) => Promise<TurnExtraction>;

const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    client: { type: "string", nullable: true },
    objective: { type: "string", nullable: true },
    audience: { type: "string", nullable: true },
    channels: { type: "string", nullable: true },
  },
  required: ["client", "objective", "audience", "channels"],
} as const;

const SYSTEM_INSTRUCTION = `You read one message from a content creator and report only what it actually states.

Report a field only when the message genuinely says it. Do not infer, do not
complete, do not fill a field because it seems likely. A message that names none
of the four fields must return null for all four -- that is a correct answer,
not a failure.

Never treat a question as a statement: "who should this target?" states no
audience.`;

function buildPrompt(turn: string, clientName: string | null): string {
  return [
    "A content creator is describing work they want produced.",
    clientName ? `This conversation is about the client "${clientName}".` : "",
    "",
    "Their message:",
    '"""',
    turn,
    '"""',
    "",
    "Report only what this message states:",
    "- client: the client or brand it is for",
    "- objective: what the campaign should achieve",
    "- audience: who it speaks to",
    "- channels: where it runs (instagram, tiktok, email, ...)",
    "",
    "Use null for anything the message does not state.",
  ]
    .filter(Boolean)
    .join("\n");
}

export const extractBriefFields: FieldExtractor = async (turn, clientName) => {
  return generateStructured<TurnExtraction>(buildPrompt(turn, clientName), EXTRACTION_SCHEMA, {
    temperature: TEMPERATURE.deterministic,
    systemInstruction: SYSTEM_INSTRUCTION,
  });
};
