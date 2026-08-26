import { notFound } from "next/navigation";

import { prisma } from "@/db";
import { visibleClientIds } from "@/domain/accessScope";
import {
  ConversationAccessError,
  ConversationNotFoundError,
  listConversations,
  loadConversation,
} from "@/domain/conversations";
import type { ActingUser } from "@/api/request";

/**
 * What the two chat screens read.
 *
 * Shared because the creator's page and the lead's ask the database exactly the
 * same questions -- only the nav around them differs. The scoping is
 * `visibleClientIds`', not a rule invented here: a creator gets their
 * assignments, a lead gets every client, and neither is decided by this module.
 */

/** The clients this person may open a thread for, named. */
export async function chatClients(user: ActingUser) {
  const ids = await visibleClientIds(user);
  return prisma.client.findMany({
    where: { client_id: { in: ids }, status: "active" },
    select: { client_id: true, name: true },
    orderBy: { name: "asc" },
  });
}

/** The thread list screen's data. */
export async function chatIndex(user: ActingUser) {
  const [threads, clients] = await Promise.all([listConversations(user), chatClients(user)]);
  return {
    threads: threads.map((thread) => ({
      conversation_id: thread.conversationId,
      client_id: thread.clientId,
      title: thread.title,
      status: thread.status,
      campaign_id: thread.campaignId,
      updated_at: thread.updatedAt.toISOString(),
    })),
    clients,
  };
}

/**
 * One thread, with its turns and what it produced.
 *
 * A thread the caller may not read is a 404 here rather than an error page. On
 * the API that distinction is a deliberate 403; in the UI there is nothing
 * useful to show either way, and "not found" is the answer that discloses
 * least.
 */
export async function chatThread(user: ActingUser, conversationId: string) {
  let conversation;
  try {
    conversation = await loadConversation(user, conversationId);
  } catch (error) {
    if (
      error instanceof ConversationAccessError ||
      error instanceof ConversationNotFoundError
    ) {
      notFound();
    }
    throw error;
  }

  const [client, items] = await Promise.all([
    prisma.client.findUnique({
      where: { client_id: conversation.client_id },
      select: { client_id: true, name: true },
    }),
    conversation.campaign_id
      ? prisma.contentItem.findMany({
          where: { campaign_id: conversation.campaign_id },
          orderBy: { created_at: "asc" },
          select: {
            content_item_id: true,
            content_form: true,
            platform: true,
            content_body: true,
            status: true,
            citations: { select: { clause_id: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  return {
    conversation,
    clientName: client?.name ?? conversation.client_id,
    turns: conversation.turns.map((turn) => ({
      turn_id: turn.turn_id,
      role: turn.role,
      body: turn.body,
      flag_id: turn.flag_id,
      created_at: turn.created_at.toISOString(),
    })),
    items: items.map((item) => ({
      content_item_id: item.content_item_id,
      content_form: item.content_form,
      platform: item.platform,
      content_body: item.content_body,
      status: item.status,
      citations: item.citations.map((citation) => citation.clause_id),
    })),
  };
}
