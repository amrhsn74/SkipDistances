import { notFound } from "next/navigation";

import { prisma } from "@/db";
import { visibleClientIds } from "@/domain/accessScope";
import { getGuidelinesForClient } from "@/domain/retrievalScope";
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

/**
 * The thread list screen's data.
 *
 * Each client is carried with its own brand clauses, so the guide can appear the
 * moment one is chosen in the picker rather than after a round trip. A creator
 * is assigned to a handful of clients and each guide is at most a few clauses,
 * so this is cheap -- and the alternative, fetching on change, would leave the
 * panel a beat behind the selection it describes.
 */
export async function chatIndex(user: ActingUser) {
  const [threads, clients] = await Promise.all([listConversations(user), chatClients(user)]);

  const withGuides = await Promise.all(
    clients.map(async (client) => ({
      ...client,
      // The same scoped query the engine drafts from, so what a creator reads
      // before writing is what their content will be grounded in.
      brandClauses: (await getGuidelinesForClient(client.client_id)).brand,
    })),
  );

  return {
    threads: threads.map((thread) => ({
      conversation_id: thread.conversationId,
      client_id: thread.clientId,
      title: thread.title,
      status: thread.status,
      campaign_id: thread.campaignId,
      updated_at: thread.updatedAt.toISOString(),
    })),
    clients: withGuides,
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

  // The client's own brand rules, for the panel on the thread. Read through the
  // same scoped query the engine drafts from, so what a creator reads here is by
  // construction what their content is grounded in.
  const [client, items, guide] = await Promise.all([
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
            media: {
              orderBy: { created_at: "asc" },
              select: {
                media_asset_id: true,
                asset_type: true,
                storage_url: true,
                generation_source: true,
              },
            },
          },
        })
      : Promise.resolve([]),
    getGuidelinesForClient(conversation.client_id),
  ]);

  return {
    conversation,
    clientName: client?.name ?? conversation.client_id,
    /** This client's own clauses. Empty for the majority of the roster, which
     *  has no guide and is governed by the agency standards alone. */
    brandClauses: guide.brand,
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
      media: item.media.map((asset) => ({
        media_asset_id: asset.media_asset_id,
        asset_type: asset.asset_type,
        storage_url: asset.storage_url,
        generation_source: asset.generation_source,
      })),
    })),
  };
}
