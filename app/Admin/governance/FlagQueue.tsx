"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge, EmptyState, type BadgeTone } from "../../components/Page";
import { flagMessage } from "@/domain/flagMessages";

/**
 * The misuse queue.
 *
 * Ranked by severity, worst first -- `openGovernanceFlags` does that sorting in
 * JS rather than SQL, because "high" sorts after "low" alphabetically and an
 * ORDER BY on the column would put approval churn above a cross-client breach.
 *
 * Each row has to answer three questions before it is worth anything: what
 * happened, who did it, and what rule it touches. A queue that only said
 * "off_task_generation × 4" would tell an admin there is a problem and nothing
 * about whether it matters.
 *
 * Where a flag came from a conversation, the row links into the transcript. That
 * is the difference between judging someone on a 500-character excerpt and
 * seeing the thread it sat in.
 */

export type FlagRow = {
  flag_id: string;
  flag_type: string;
  severity: string;
  created_at: string;
  resolved: boolean;
  resolution_notes: string | null;
  raised_against: { user_id: string; name: string; email: string } | null;
  /** Parsed from `details` on the server, so the client renders rather than parses. */
  detail: {
    clause_title?: string | null;
    prompt?: string | null;
    reason?: string | null;
    conversation_id?: string | null;
    action?: string | null;
    attempted_client_id?: string | null;
    matched_phrase?: string | null;
    decline_count?: number | null;
  };
  clause_code: string | null;
};

const TONE: Record<string, BadgeTone> = { high: "danger", medium: "flag", low: "neutral" };

/** What each flag type actually means, in a sentence an admin can act on. */
// The wording lives in `lib/domain/flagMessages.ts` rather than here, so the
// sentence an Admin reads and the one the creator was shown describe the same
// event in the same terms. This screen renders; it does not phrase.

export function FlagQueue({ flags }: { flags: FlagRow[] }) {
  if (flags.length === 0) {
    return <EmptyState>Nothing open. Every raised flag has been resolved.</EmptyState>;
  }

  return (
    <ul className="space-y-3">
      {flags.map((flag) => (
        <FlagCard key={flag.flag_id} flag={flag} />
      ))}
    </ul>
  );
}

function FlagCard({ flag }: { flag: FlagRow }) {
  const router = useRouter();

  const [notes, setNotes] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve() {
    if (notes.trim() === "" || busy) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/flags/${flag.flag_id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notes: notes.trim() }),
      });

      if (!response.ok) {
        const json = await response.json();
        setError(json?.error?.message ?? "Could not resolve that.");
        return;
      }

      router.refresh();
    } catch {
      setError("Could not resolve that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-2xl border border-edge bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={TONE[flag.severity] ?? "neutral"}>{flag.severity}</Badge>
            <span className="font-heading text-sm font-semibold text-heading">
              {flag.flag_type.replace(/_/g, " ")}
            </span>
            {flag.clause_code ? (
              <Badge tone="info">Clause {flag.clause_code}</Badge>
            ) : null}
            {flag.resolved ? <Badge tone="ok">resolved</Badge> : null}
          </div>

          <p className="mt-1 text-sm text-body">
            {flagMessage(
              flag.flag_type,
              {
                clauseCode: flag.clause_code,
                clauseTitle: flag.detail.clause_title ?? null,
                reason: flag.detail.reason ?? null,
              },
              "admin",
            )}
          </p>

          <p className="mt-1 text-xs text-body">
            {flag.raised_against
              ? `${flag.raised_against.name} · ${flag.raised_against.email}`
              : "No person named — raised by the engine about a brief."}
            {" · "}
            {new Date(flag.created_at).toLocaleString()}
          </p>
        </div>

        {!flag.resolved ? (
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            className="shrink-0 rounded-xl border border-edge px-3 py-1.5 text-xs font-semibold text-heading hover:border-amber-brand"
          >
            {open ? "Cancel" : "Resolve"}
          </button>
        ) : null}
      </div>

      <Detail flag={flag} />

      {flag.resolved && flag.resolution_notes ? (
        <p className="mt-2 rounded-xl border border-edge bg-canvas px-3 py-2 text-xs text-body">
          Resolved: {flag.resolution_notes}
        </p>
      ) : null}

      {open ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={2}
            placeholder="What was done about it?"
            className="w-full resize-none rounded-xl border border-edge bg-surface px-3 py-2 text-sm outline-none focus:border-amber-brand"
          />
          {/* Notes are required, not optional. A flag closed with no explanation
              removes the row from the queue and takes the reason with it. */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void resolve()}
              disabled={busy || notes.trim() === ""}
              className="rounded-xl bg-amber-brand px-4 py-2 text-sm font-semibold text-ink transition hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Mark resolved"}
            </button>
            {error ? (
              <span className="text-sm text-danger" role="alert">
                {error}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** The context that makes a row actionable rather than a label. */
function Detail({ flag }: { flag: FlagRow }) {
  const { detail } = flag;

  return (
    <div className="mt-2 space-y-1">
      {detail.prompt ? (
        <p className="rounded-xl border border-edge bg-canvas px-3 py-2 text-xs text-heading">
          “{detail.prompt}”
        </p>
      ) : null}

      {detail.reason ? (
        <p className="text-xs text-body">The engine took this to be: {detail.reason}</p>
      ) : null}

      {detail.matched_phrase ? (
        <p className="text-xs text-body">Matched: “{detail.matched_phrase}”</p>
      ) : null}

      {detail.action ? (
        <p className="text-xs text-body">Attempted: {detail.action}</p>
      ) : null}

      {detail.attempted_client_id ? (
        <p className="text-xs text-body">Reached for: {detail.attempted_client_id}</p>
      ) : null}

      {typeof detail.decline_count === "number" ? (
        <p className="text-xs text-body">Declined {detail.decline_count} times.</p>
      ) : null}

      {detail.conversation_id ? (
        <Link
          href={`/Admin/conversations/${detail.conversation_id}`}
          className="inline-block text-xs font-semibold text-amber-dark hover:underline"
        >
          Open the conversation →
        </Link>
      ) : null}
    </div>
  );
}
