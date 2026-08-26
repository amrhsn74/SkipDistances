import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { chatTurn } from "@/engine/chatTurn";

/**
 * One turn of a conversation, over HTTP.
 *
 * Everything this route does not decide is the point of it. Whether the turn is
 * on-task, whether the thread yet says enough to draft from, whether what comes
 * out is drafted or flagged -- all `chatTurn`'s, and through it the same engine
 * the account manager's brief runs through. This handler reads a body, calls one
 * function, and shapes the answer.
 *
 * Ownership is enforced inside `chatTurn` rather than here, for the reason the
 * regenerate route gives: authorisation on the write path cannot be forgotten by
 * a second caller added later.
 */

// Reads the session cookie and writes. Never cached.
export const dynamic = "force-dynamic";

/**
 * POST /api/conversations/[id]/turns
 *
 * Answers 200 for all three outcomes -- refused, asking, produced -- because all
 * three are the engine having run and reached a verdict. A refusal in particular
 * is not a 4xx: the caller was permitted to send it, and their next message will
 * work fine. The client branches on `status`.
 *
 * That differs from `/api/content-items/[id]/regenerate`, where an off-task
 * prompt surfaces as 422 via `OffTaskPromptError`. The difference is deliberate:
 * a regeneration either happens or does not, so a refusal is an error state,
 * whereas a conversation continues -- the refusal *is* the turn's answer, and it
 * is already stored as one.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();

    const body = (await request.json()) as Record<string, unknown>;
    const prompt = typeof body.prompt === "string" ? body.prompt : "";

    const result = await chatTurn(user, params.id, prompt);

    if (result.status === "refused") {
      return NextResponse.json({
        status: result.status,
        assistant_message: result.assistantMessage,
        // The model's own reason, shown to the creator so a refusal is legible
        // rather than a wall. The same text reaches the Admin on the flag.
        reason: result.verdict.reason,
      });
    }

    if (result.status === "asking") {
      return NextResponse.json({
        status: result.status,
        assistant_message: result.assistantMessage,
        // What the thread still needs, so a screen can show progress rather than
        // an unexplained series of questions.
        missing: result.accumulated.missing,
        fields: result.accumulated.fields,
      });
    }

    if (result.status === "failed") {
      // 200, not 500. The engine ran, the turn is stored, and the thread is
      // intact -- the creator's remedy is to send another message, which is a
      // normal conversational outcome rather than a broken request.
      return NextResponse.json({
        status: result.status,
        assistant_message: result.assistantMessage,
        fields: result.accumulated.fields,
      });
    }

    const { submitted } = result;

    // `submitted.run` carries the whole engine trace -- every retrieved clause,
    // the full generated plan, every compliance judgement. Not returned, for the
    // reason the campaigns route gives: it is large, and a screen that needs the
    // detail reads the persisted ContentItem and Flag rows the run wrote.
    const { run, ...summary } = submitted;
    void run;

    return NextResponse.json({
      status: result.status,
      assistant_message: result.assistantMessage,
      fields: result.accumulated.fields,
      ...summary,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
