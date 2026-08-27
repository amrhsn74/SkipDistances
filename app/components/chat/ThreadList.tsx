"use client";

import Link from "next/link";

import { EmptyState } from "../Page";
import { StartChat, type ChatClient } from "./StartChat";

/**
 * A person's threads, and the way to start another.
 *
 * `showClient` is the one difference between the creator's list and the lead's:
 * a lead works across clients, so their list has to say which client a thread
 * belongs to, while a creator's would be a column of near-identical values. The
 * alternative -- two components -- would drift the moment either gained a
 * column.
 */

export type ThreadSummary = {
  conversation_id: string;
  client_id: string;
  title: string | null;
  status: string;
  campaign_id: string | null;
  updated_at: string;
};

export function ThreadList({
  threads,
  clients,
  basePath,
  showClient,
}: {
  threads: ThreadSummary[];
  /** The clients this person may open a thread for, with their brand rules. */
  clients: ChatClient[];
  /** `/Creator/chat` or `/ContentLead/chat`. */
  basePath: string;
  showClient: boolean;
}) {
  const clientName = new Map(clients.map((client) => [client.client_id, client.name]));

  return (
    <div className="space-y-6">
      <StartChat clients={clients} basePath={basePath} />

      {threads.length === 0 ? (
        <EmptyState>No conversations yet. Say what you need above.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {threads.map((thread) => (
            <li key={thread.conversation_id}>
              <Link
                href={`${basePath}/${thread.conversation_id}`}
                className="flex items-center justify-between gap-4 rounded-xl border border-edge bg-surface px-4 py-3 hover:border-amber-brand"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-heading">
                    {thread.title ?? "Untitled conversation"}
                  </p>
                  <p className="mt-0.5 text-xs text-body">
                    {showClient
                      ? `${clientName.get(thread.client_id) ?? thread.client_id} · `
                      : ""}
                    {new Date(thread.updated_at).toLocaleDateString()}
                    {/* A thread that has produced work is a different thing
                        from one still being assembled, and the list should say
                        so without being opened. */}
                    {thread.campaign_id ? " · produced work" : ""}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
