"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { EmptyState } from "../Page";

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
  /** The clients this person may open a thread for. */
  clients: { client_id: string; name: string }[];
  /** `/Creator/chat` or `/ContentLead/chat`. */
  basePath: string;
  showClient: boolean;
}) {
  const clientName = new Map(clients.map((client) => [client.client_id, client.name]));

  return (
    <div className="space-y-6">
      <NewThread clients={clients} basePath={basePath} />

      {threads.length === 0 ? (
        <EmptyState>No conversations yet. Start one above.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {threads.map((thread) => (
            <li key={thread.conversation_id}>
              <Link
                href={`${basePath}/${thread.conversation_id}`}
                className="flex items-center justify-between gap-4 rounded-xl border border-edge bg-surface px-4 py-3 hover:border-accent"
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

function NewThread({
  clients,
  basePath,
}: {
  clients: { client_id: string; name: string }[];
  basePath: string;
}) {
  const router = useRouter();

  const [clientId, setClientId] = useState(clients[0]?.client_id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    if (!clientId || busy) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: clientId }),
      });
      const json = await response.json();

      if (!response.ok) {
        setError(json?.error?.message ?? "Could not start that conversation.");
        return;
      }

      router.push(`${basePath}/${json.conversation_id}`);
    } catch {
      setError("Could not start that conversation.");
    } finally {
      setBusy(false);
    }
  }

  if (clients.length === 0) {
    return (
      <EmptyState>
        You are not assigned to any clients yet, so there is nothing to write for.
      </EmptyState>
    );
  }

  return (
    <div className="rounded-2xl border border-edge bg-surface p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex-1">
          <span className="mb-1 block text-xs font-semibold text-heading">Client</span>
          <select
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            className="w-full rounded-xl border border-edge bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
          >
            {clients.map((client) => (
              <option key={client.client_id} value={client.client_id}>
                {client.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void open()}
          disabled={busy}
          className="rounded-xl bg-accent px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          New conversation
        </button>
      </div>
      {/* The client is fixed when the thread opens and never changes: every
          later turn grounds in one client's rules without re-deciding whose. */}
      <p className="mt-2 text-xs text-body">
        A conversation stays with the client it was opened for.
      </p>
      {error ? (
        <p className="mt-2 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
