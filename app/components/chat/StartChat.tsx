"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { EmptyState } from "../Page";
import { ClientGuidePanel } from "./ClientGuidePanel";
import { ACCEPTED_MIME_TYPES } from "@/domain/referenceTypes";
import type { ScopedClause } from "@/domain/retrievalScope";

import {
  PromptInput,
  PromptInputActions,
  PromptInputAttach,
  PromptInputSubmit,
  PromptInputTextarea,
} from "./PromptInput";

/**
 * The box you type in first.
 *
 * The thread list used to offer only a client picker and a "New conversation"
 * button, which put two clicks between someone arriving and someone typing --
 * and made a chat screen look like a form. Here the message box *is* the entry
 * point: pick who it is for, say what you need, and the thread is created and
 * the first turn sent in one action.
 *
 * Two requests, deliberately, rather than one endpoint that does both. Opening a
 * thread and taking a turn are genuinely different operations -- the first is
 * cheap and always succeeds, the second may spend a model call and may be
 * refused. Folding them together would mean a refused first turn either leaves
 * an empty thread behind or destroys one, and both are worse than a thread that
 * exists with a refusal recorded in it, which is what the Admin needs to see
 * anyway.
 */
/** A client the picker offers, with the rules that govern their content. */
export type ChatClient = {
  client_id: string;
  name: string;
  brandClauses: ScopedClause[];
};

export function StartChat({
  clients,
  basePath,
}: {
  clients: ChatClient[];
  basePath: string;
}) {
  const router = useRouter();

  const [clientId, setClientId] = useState(clients[0]?.client_id ?? "");
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = clients.find((client) => client.client_id === clientId);
  const clientName = chosen?.name ?? "this client";

  async function start() {
    const text = prompt.trim();
    if (!clientId || !text || busy) return;

    setBusy(true);
    setError(null);

    try {
      const opened = await fetch("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The opening words become the thread's title, so the list reads as
        // what people asked for rather than a column of "Untitled".
        body: JSON.stringify({ client_id: clientId, title: text.slice(0, 60) }),
      });
      const conversation = await opened.json();

      if (!opened.ok) {
        setError(conversation?.error?.message ?? "Could not start that conversation.");
        return;
      }

      const sent = await fetch(`/api/conversations/${conversation.conversation_id}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      });

      if (!sent.ok) {
        // The thread exists and the turn did not land. Sending the person into
        // it is still the right move -- they can retry there, with everything
        // they typed still on screen rather than lost to a toast.
        router.push(`${basePath}/${conversation.conversation_id}`);
        return;
      }

      router.push(`${basePath}/${conversation.conversation_id}`);
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
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void start();
      }}
      className="rounded-2xl border border-edge bg-surface p-4"
    >
      <label className="mb-3 block">
        <span className="mb-1 block text-xs font-semibold text-heading">Client</span>
        <select
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          className="w-full max-w-xs rounded-xl border border-edge bg-surface px-3 py-2 text-sm outline-none focus:border-amber-brand"
        >
          {clients.map((client) => (
            <option key={client.client_id} value={client.client_id}>
              {client.name}
            </option>
          ))}
        </select>
      </label>

      {/* The chosen client's own rules, shown only once there is a chosen
          client. Before that there is no such thing as "the brand guide" --
          which is exactly why the nav holds the agency standards instead. */}
      {chosen ? (
        <div className="mb-3">
          <ClientGuidePanel clientName={chosen.name} clauses={chosen.brandClauses} />
        </div>
      ) : null}

      <PromptInput
        value={prompt}
        onValueChange={setPrompt}
        onSubmit={() => void start()}
        isLoading={busy}
        disabled={busy}
      >
        <PromptInputTextarea
          placeholder={`What do you need for ${clientName}? For example: three Instagram posts launching the new cold brew, aimed at office workers.`}
          autoFocus
        />
        <PromptInputActions className="justify-between px-1 pb-1">
          <PromptInputAttach
            files={files}
            onFiles={setFiles}
            disabled={busy}
            accept={ACCEPTED_MIME_TYPES.join(",")}
          />
          <PromptInputSubmit
            disabled={busy || prompt.trim() === ""}
            isLoading={busy}
            label="Start"
          />
        </PromptInputActions>
      </PromptInput>

      <p className="mt-2 text-xs text-body">
        Grounded in {clientName}&rsquo;s brand guide and the agency standards. The engine will ask
        if anything is missing, and nothing publishes without both approvals.
      </p>

      {error ? (
        <p className="mt-2 text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
