import { prisma, type Db } from "../db";
import type { ScopeUser } from "./accessScope";
import { writeAudit } from "./auditLog";
import { enforce } from "./permissions";

/**
 * Threads, and who may reach them.
 *
 * Two separate questions are answered here, and conflating them is the mistake
 * this module exists to prevent:
 *
 *   1. **May this person use the chat surface for this client at all?**
 *      `content.chat`, client-scoped, answered by `enforce`. A creator reaches
 *      only clients they are assigned to; a lead reaches every client.
 *   2. **May this person read *this thread*?**
 *      Ownership. A creator's conversation is theirs -- another creator on the
 *      same client cannot read it, because a transcript is a record of how one
 *      person worked, and the Admin's conduct review depends on that being true.
 *
 * The second is stricter than the first, deliberately. Passing the capability
 * check does not grant the transcript: a lead who may chat for every client
 * still reads their own threads on the thread list, and reaches someone else's
 * only through the oversight path, which is the Admin's misuse queue rather than
 * this module.
 */

/** Who may read any thread, not merely their own. */
const OVERSIGHT_ROLES = new Set(["agency_admin"]);

export class ConversationNotFoundError extends Error {
  readonly code = "CONVERSATION_NOT_FOUND";
  constructor(conversationId: string) {
    super(`No conversation ${conversationId}.`);
    this.name = "ConversationNotFoundError";
  }
}

export class ConversationAccessError extends Error {
  readonly code = "CONVERSATION_ACCESS";
  constructor(conversationId: string, userId: string) {
    super(`User ${userId} may not read conversation ${conversationId}.`);
    this.name = "ConversationAccessError";
  }
}

export type TurnRole = "creator" | "assistant" | "system";

export type ConversationSummary = {
  conversationId: string;
  clientId: string;
  title: string | null;
  status: string;
  campaignId: string | null;
  updatedAt: Date;
};

/**
 * Open a thread for a client.
 *
 * The client is fixed at creation and never changes. A conversation that could
 * be repointed at another client would carry its transcript -- and everything
 * the engine had already grounded in the first client's rules -- across a
 * boundary the whole system is built to hold.
 */
export async function openConversation(
  user: ScopeUser & { status?: string },
  clientId: string,
  title: string | null,
  db: Db = prisma,
): Promise<ConversationSummary> {
  await enforce(user, "content.chat", { clientId }, db);

  const conversation = await db.conversation.create({
    data: {
      client_id: clientId,
      created_by_id: user.user_id,
      title: title?.trim() || null,
      status: "active",
    },
    select: {
      conversation_id: true,
      client_id: true,
      title: true,
      status: true,
      campaign_id: true,
      updated_at: true,
    },
  });

  await writeAudit(
    {
      entityType: "Conversation",
      entityId: conversation.conversation_id,
      action: "created",
      performedById: user.user_id,
      details: { client_id: clientId },
    },
    db,
  );

  return toSummary(conversation);
}

/** The threads this person owns, most recently touched first. */
export async function listConversations(
  user: ScopeUser,
  db: Db = prisma,
): Promise<ConversationSummary[]> {
  const rows = await db.conversation.findMany({
    where: { created_by_id: user.user_id },
    orderBy: { updated_at: "desc" },
    select: {
      conversation_id: true,
      client_id: true,
      title: true,
      status: true,
      campaign_id: true,
      updated_at: true,
    },
  });
  return rows.map(toSummary);
}

/**
 * One thread with its turns.
 *
 * Ownership, then capability -- in that order. Someone who owns the thread but
 * has since lost `content.chat` on the client can still read what they wrote,
 * which is what makes a transcript a record rather than something that vanishes
 * when a role changes.
 */
export async function loadConversation(
  user: ScopeUser & { status?: string },
  conversationId: string,
  db: Db = prisma,
) {
  const conversation = await db.conversation.findUnique({
    where: { conversation_id: conversationId },
    select: {
      conversation_id: true,
      client_id: true,
      created_by_id: true,
      campaign_id: true,
      title: true,
      status: true,
      updated_at: true,
      turns: {
        orderBy: { created_at: "asc" },
        select: {
          turn_id: true,
          role: true,
          body: true,
          flag_id: true,
          created_at: true,
        },
      },
    },
  });

  if (!conversation) throw new ConversationNotFoundError(conversationId);

  const owns = conversation.created_by_id === user.user_id;
  const oversight = user.is_agency_admin === true;

  if (!owns && !oversight) {
    // Deliberately the same error whether the thread exists and belongs to
    // someone else, or the caller simply may not have it. Distinguishing the two
    // would let a creator enumerate their colleagues' threads by id.
    throw new ConversationAccessError(conversationId, user.user_id);
  }

  return conversation;
}

/**
 * Append a turn.
 *
 * Capability is re-checked on every append rather than trusted from whenever the
 * thread was opened -- an assignment revoked an hour ago takes effect on the
 * next message, not at the next login.
 */
export async function appendTurn(
  user: ScopeUser & { status?: string },
  conversationId: string,
  role: TurnRole,
  body: string,
  db: Db = prisma,
) {
  const conversation = await db.conversation.findUnique({
    where: { conversation_id: conversationId },
    select: { conversation_id: true, client_id: true, created_by_id: true },
  });

  if (!conversation) throw new ConversationNotFoundError(conversationId);

  if (conversation.created_by_id !== user.user_id) {
    throw new ConversationAccessError(conversationId, user.user_id);
  }

  await enforce(user, "content.chat", { clientId: conversation.client_id }, db);

  const turn = await db.conversationTurn.create({
    data: { conversation_id: conversationId, role, body },
    select: { turn_id: true, role: true, body: true, created_at: true },
  });

  // Touched so the thread list orders by real activity rather than by when the
  // thread happened to be opened.
  await db.conversation.update({
    where: { conversation_id: conversationId },
    data: { updated_at: new Date() },
  });

  return turn;
}

/** Mark the turn that was refused, linking it to the Admin's queue row. */
export async function attachFlagToTurn(turnId: string, flagId: string, db: Db = prisma) {
  await db.conversationTurn.update({
    where: { turn_id: turnId },
    data: { flag_id: flagId },
  });
}

/** Bind a thread to the campaign it produced, once it has one. */
export async function linkCampaign(
  conversationId: string,
  campaignId: string,
  db: Db = prisma,
) {
  await db.conversation.update({
    where: { conversation_id: conversationId },
    data: { campaign_id: campaignId },
  });
}

function toSummary(row: {
  conversation_id: string;
  client_id: string;
  title: string | null;
  status: string;
  campaign_id: string | null;
  updated_at: Date;
}): ConversationSummary {
  return {
    conversationId: row.conversation_id,
    clientId: row.client_id,
    title: row.title,
    status: row.status,
    campaignId: row.campaign_id,
    updatedAt: row.updated_at,
  };
}
