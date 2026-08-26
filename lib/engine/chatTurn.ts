import { prisma, type Db } from "../db";
import type { ScopeUser } from "../domain/accessScope";
import {
  foldExtractions,
  nextQuestion,
  toBriefText,
  type AccumulatedBrief,
  type TurnExtraction,
} from "../domain/briefAccumulation";
import {
  appendTurn,
  linkCampaign,
  attachFlagToTurn,
  ConversationNotFoundError,
  ConversationAccessError,
} from "../domain/conversations";
import { guideDefaults, type GuideDefaults } from "../domain/guideDefaults";
import { getGuidelinesForClient } from "../domain/retrievalScope";
import { writeAudit } from "../domain/auditLog";
import { flagOffTaskGeneration } from "../domain/misuse";
import { checkTurnOnTask, type OnTaskJudge, type OnTaskVerdict } from "./onTaskCheck";
import { extractBriefFields, type FieldExtractor } from "./extractBriefFields";
import { proposePlan, type ProposedItem } from "./proposePlan";
import { submitBrief, type SubmitBriefResult } from "./submitBrief";
import type { Selection } from "../domain/planSelection";
import { flagMessage } from "../domain/flagMessages";

/**
 * One turn of a conversation.
 *
 * The whole of the chat path's control flow lives here, and its shape is the
 * argument for the design: nothing below generates content. When the thread has
 * said enough, it calls `submitBrief` -- the same function the account manager's
 * form calls -- and every guard that path runs, this path runs, because it is
 * literally the same code. Client resolution, the completeness check, override
 * detection, retrieval, compliance, the four outcomes, the queue: all of it,
 * unchanged and unduplicated.
 *
 * What this function actually decides is only ever *when* to call it.
 *
 * The order matters and is deliberate:
 *
 *   1. **On-task, first.** Before anything is extracted and before the engine is
 *      reachable, because the plan requires a refused prompt to "cost nothing
 *      further". A refusal stores the turn -- it is evidence -- and stops.
 *   2. **Extract, then fold.** What this turn added, folded onto what the thread
 *      already knew.
 *   3. **Ask, propose, or draft.** Missing Clause 0.5 fields become the next
 *      question. A complete fold gets a *proposal* -- a list of what could be
 *      drafted, costing one plan call and writing no content. Only when the
 *      creator picks from it does the ordinary pipeline run, on their items
 *      alone.
 *
 * Step 3 is the one to keep honest over time. The temptation later will be to
 * let a nearly-complete thread generate "something useful anyway". That is
 * precisely the guess Clause 0.5 forbids, and the day it is added is the day
 * B-012 and B-013 start passing when they should not.
 *
 * The same temptation applies to the proposal: drafting the whole plan because
 * the creator "probably wants it all" puts work in the queue nobody chose, which
 * is the thing this split exists to stop.
 */

export type ChatTurnDependencies = {
  /** Pulls the four Clause 0.5 fields out of one turn. */
  extract: FieldExtractor;
  /** Judges whether the turn belongs to this thread's work. */
  onTaskJudge?: OnTaskJudge;
  /**
   * Generates the offer. Injected for the same reason every other model call in
   * the engine is: what is worth testing here is the propose-then-draft
   * sequencing, and that needs no real plan behind it.
   */
  propose?: typeof proposePlan;
  /**
   * Runs the chosen items through the real pipeline. Injected so a test can
   * assert *what was selected* without standing up compliance and retrieval.
   */
  submit?: typeof submitBrief;
};

export type ChatTurnResult =
  /** The turn was refused. Nothing was produced, nothing was spent. */
  | {
      status: "refused";
      verdict: OnTaskVerdict;
      assistantMessage: string;
    }
  /** The thread does not yet say enough. The engine asked for what is missing. */
  | {
      status: "asking";
      accumulated: AccumulatedBrief;
      assistantMessage: string;
    }
  /**
   * The thread says enough, and the engine has offered a plan.
   *
   * Nothing is drafted at this point and no campaign row exists. The creator
   * picks from `items`, and only then does the ordinary pipeline run on what
   * they chose.
   */
  | {
      status: "proposed";
      accumulated: AccumulatedBrief;
      assistantMessage: string;
      items: ProposedItem[];
    }
  /** The thread produced work. `submitted` is the ordinary intake result. */
  | {
      status: "produced";
      accumulated: AccumulatedBrief;
      assistantMessage: string;
      submitted: SubmitBriefResult;
    }
  /**
   * The engine ran and came back with something unusable.
   *
   * Distinct from `refused`, which is the engine working correctly and declining
   * on purpose. This is a fault, and the creator's remedy is to try again rather
   * than to change what they asked for.
   */
  | {
      status: "failed";
      accumulated: AccumulatedBrief;
      assistantMessage: string;
    };

export class ChatTurnError extends Error {
  readonly code = "CHAT_TURN";
  constructor(message: string) {
    super(message);
    this.name = "ChatTurnError";
  }
}

export async function chatTurn(
  user: ScopeUser & { status?: string },
  conversationId: string,
  prompt: string,
  db: Db = prisma,
  dependencies: ChatTurnDependencies = { extract: extractBriefFields },
  /**
   * Which proposed items to draft, by index into the plan the previous
   * assistant turn offered.
   *
   * Absent on an ordinary message, which is why a complete thread proposes
   * rather than drafts: the creator has not chosen yet. Present only when they
   * answer a proposal, and then it is the whole of what gets built.
   */
  selection?: Selection,
): Promise<ChatTurnResult> {
  const text = prompt.trim();
  if (!text) throw new ChatTurnError("A turn needs something to say.");

  const conversation = await db.conversation.findUnique({
    where: { conversation_id: conversationId },
    select: {
      conversation_id: true,
      client_id: true,
      created_by_id: true,
      campaign_id: true,
      client: { select: { client_id: true, name: true } },
      turns: {
        orderBy: { created_at: "asc" },
        select: { role: true, body: true },
      },
    },
  });

  if (!conversation) throw new ConversationNotFoundError(conversationId);
  if (conversation.created_by_id !== user.user_id) {
    throw new ConversationAccessError(conversationId, user.user_id);
  }

  // What this client's own brand guide already answers. Every brand guide states
  // an audience clause and several name their channels, so asking the creator
  // for them is asking them to retype a rule the agency holds -- and inviting an
  // answer that contradicts it, which Clause 0.4 would then have to flag.
  //
  // The same double-scoped query the drafting step uses, so a thread can only
  // ever be seeded from its own client's active guide.
  const defaults: GuideDefaults = {
    // The thread's client, which is known by construction: a conversation is
    // opened against one client and `toBriefText` files the brief under it
    // regardless. Asking "which client is this for?" could therefore never be a
    // question worth asking -- it was reachable only because the fold could not
    // see what the thread already knew.
    client: { value: conversation.client.name },
    ...guideDefaults((await getGuidelinesForClient(conversation.client_id, db)).all),
  };

  // What the thread already established, before this turn is considered. Used
  // both to judge the turn and, if it is allowed, as the base of the fold.
  const priorExtractions = await extractionsFor(conversation.turns, dependencies);
  const prior = foldExtractions(priorExtractions, defaults);

  // --- 1. Is this turn part of this thread's work? ---
  const verdict = await checkTurnOnTask(
    text,
    {
      clientId: conversation.client.client_id,
      clientName: conversation.client.name,
      priorTurns: conversation.turns,
      objective: prior.fields.objective ?? null,
      deliverables: prior.fields.channels ?? null,
    },
    dependencies.onTaskJudge,
  );

  // The creator's turn is stored either way. A refused turn is the evidence the
  // Admin reviews -- discarding it would leave a flag pointing at nothing.
  const creatorTurn = await appendTurn(user, conversationId, "creator", text, db);

  if (!verdict.onTask) {
    const flag = await flagOffTaskGeneration(
      {
        raisedAgainstId: user.user_id,
        prompt: text,
        reason: verdict.reason,
        conversationId,
      },
      db,
    );

    await attachFlagToTurn(creatorTurn.turn_id, flag.flag_id, db);

    const assistantMessage =
      "That is outside what this conversation is for. It is scoped to producing " +
      `content for ${conversation.client.name}, and this has been recorded.`;
    await appendTurn(user, conversationId, "assistant", assistantMessage, db);

    return { status: "refused", verdict, assistantMessage };
  }

  // --- 2. What did this turn add? ---
  const extraction = await dependencies.extract(text, conversation.client.name);
  const accumulated = foldExtractions([...priorExtractions, extraction], defaults);

  // --- 3. Ask, propose, or draft. ---
  const question = nextQuestion(accumulated);
  if (question) {
    // Clause 0.5, asked rather than returned. Nothing is guessed and nothing is
    // generated until all four fields are actually present.
    await appendTurn(user, conversationId, "assistant", question, db);
    return { status: "asking", accumulated, assistantMessage: question };
  }

  // The conversation's client, passed explicitly: the campaign row is filed
  // against it, so the brief must name it too. See `toBriefText`.
  const briefText = toBriefText(
    accumulated,
    [...conversation.turns, { role: "creator", body: text }],
    conversation.client.name,
    conversation.client.client_id,
  );

  // --- 3a. Nothing chosen yet: offer a plan and stop. ---
  //
  // The creator decides what gets drafted. Reaching this point used to mean the
  // engine generated, judged, persisted and illustrated everything it thought of
  // -- work nobody had asked for item by item, and model calls spent on it. Now
  // the thread offers, and the offer costs one plan call and writes no content.
  //
  // The guards have not moved: `proposePlan` runs the same intake steps, so an
  // unknown client or an incomplete brief still halts here rather than being
  // discovered after a creator has picked from a list they could not act on.
  if (!selection) {
    const proposal = await (dependencies.propose ?? proposePlan)(
      conversation.client_id,
      briefText,
      db,
    );

    if (proposal.status === "halted") {
      const assistantMessage = `${proposal.reason} (Clause ${proposal.clauseCode})`;
      await appendTurn(user, conversationId, "assistant", assistantMessage, db);
      return { status: "asking", accumulated, assistantMessage };
    }

    const assistantMessage = describeProposal(proposal.items);

    // The offer is stored on the turn that made it, so the indices the creator
    // sends back can be read against the list they were actually shown.
    await appendTurn(user, conversationId, "assistant", assistantMessage, db, {
      items: proposal.items,
      notes: proposal.notes,
    });

    return {
      status: "proposed",
      accumulated,
      assistantMessage,
      items: proposal.items,
    };
  }

  // The same function the account manager's form calls. Everything the brief
  // path guarantees follows from this line and nothing else in this module.
  //
  // Wrapped, because a conversation must survive a bad generation. The account
  // manager's form can afford to surface an engine failure as an error page --
  // they still have their brief and can resubmit it. A creator mid-thread cannot:
  // an unhandled throw here is a 500 that loses the turn, leaves the thread
  // looking broken, and gives them nothing to do about it. So a generation that
  // comes back unusable is reported *as a turn* -- the thread stays intact, the
  // words are still there, and trying again is one message rather than a reload.
  let submitted: SubmitBriefResult;
  try {
    submitted = await (dependencies.submit ?? submitBrief)(
      {
        clientId: conversation.client_id,
        rawBriefText: briefText,
        title: accumulated.fields.objective ?? null,
        // Only what the creator ticked. `runIntake` narrows the generated plan
        // to these before compliance runs, so an unchosen item is never judged,
        // never persisted and never illustrated.
        selection,
      },
      user.user_id,
      db,
    );
  } catch (error) {
    const assistantMessage =
      "The engine came back with something I could not use, so nothing was drafted. " +
      "Try saying that again, or add a little more detail.";

    await appendTurn(user, conversationId, "assistant", assistantMessage, db);

    // Recorded rather than swallowed: an engine returning unusable output
    // repeatedly is a real problem, and a trail that says only "the creator
    // asked twice" would hide it.
    await writeAudit(
      {
        entityType: "Conversation",
        entityId: conversationId,
        action: "edited",
        performedById: user.user_id,
        details: {
          generation_failed: error instanceof Error ? error.message : String(error),
        },
      },
      db,
    );

    return { status: "failed", accumulated, assistantMessage };
  }

  await linkCampaign(conversationId, submitted.campaign.campaign_id, db);

  const assistantMessage = describe(submitted);
  await appendTurn(user, conversationId, "assistant", assistantMessage, db);

  return { status: "produced", accumulated, assistantMessage, submitted };
}

/**
 * The thread's prior turns, re-extracted.
 *
 * Re-run rather than stored, because the extraction is a pure function of the
 * text and storing it would create a second copy that can drift from the turn it
 * describes. The cost is real -- one call per prior creator turn -- and is the
 * obvious thing to cache later; it is not cached now because a cache that can go
 * stale is worse than a cost that is merely visible.
 */
async function extractionsFor(
  turns: { role: string; body: string }[],
  dependencies: ChatTurnDependencies,
): Promise<TurnExtraction[]> {
  const creatorTurns = turns.filter((turn) => turn.role === "creator");
  const out: TurnExtraction[] = [];
  for (const turn of creatorTurns) {
    out.push(await dependencies.extract(turn.body, null));
  }
  return out;
}

/** Newline, named so it survives an editor that reflows string literals. */
const BREAK = String.fromCharCode(10);

/**
 * What the assistant says when it offers a plan.
 *
 * The items are numbered because the creator answers with numbers, and the
 * clauses each would be written under are named because that is the information
 * the choice actually turns on -- a creator picking between an Instagram post
 * and a LinkedIn one is choosing which rules apply.
 */
function describeProposal(items: ProposedItem[]): string {
  if (items.length === 0) {
    return "I could not find anything worth proposing for that. Try saying more about what you need.";
  }

  const lines = items.map((item, index) => {
    const where = item.platform ? ` · ${item.platform}` : "";
    const clauses =
      item.clause_codes.length > 0 ? ` — under ${item.clause_codes.join(", ")}` : "";
    return `${index + 1}. ${item.title} (${item.content_form}${where})${clauses}`;
  });

  return [
    `Here is what I can draft. Choose the ones you want and nothing else is written:`,
    "",
    ...lines,
  ].join(BREAK);
}

/** What the assistant says once the engine has run. */
function describe(submitted: SubmitBriefResult): string {
  const { drafted, flagged, requestInfo } = submitted.counts;

  switch (submitted.outcome) {
    case "DRAFT":
      return `Drafted ${drafted} item${drafted === 1 ? "" : "s"}. Each one cites the rules it was written under -- review them, then submit for approval.`;
    case "FLAG": {
      // Phrased through the shared table so the creator reads the same sentence
      // the Admin would, and told plainly that nothing has been reported: the
      // flag is on the draft, not on them, and it stays that way unless they
      // submit the item anyway. See `queueOrFlag` and `submitForReview`.
      const explanation = flagMessage(submitted.flagType ?? "brand_violation", {
        clauseCode: submitted.clauseCode,
        clauseTitle: submitted.clauseTitle,
        clientName: submitted.clientName,
        reason: submitted.reason,
      });

      return `${explanation} ${flagged} item${flagged === 1 ? "" : "s"} held back — nothing has been reported, and nothing will be unless you submit it as it stands.`;
    }
    case "REQUEST_INFO": {
      const reason = submitted.reason ?? "I need more before I can draft this.";
      return `${reason} (${requestInfo} item${requestInfo === 1 ? "" : "s"} waiting on it.)`;
    }
    case "REFUSE_OVERRIDE":
      return "Drafted, but this cannot be scheduled: the brief tried to skip an approval, which is recorded and refused. Both review stages still apply.";
  }
}
