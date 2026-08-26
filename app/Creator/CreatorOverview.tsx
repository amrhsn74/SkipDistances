import Link from "next/link";

import { Badge, Card, EmptyState } from "../components/Page";

/**
 * What a creator has in front of them, at a glance.
 *
 * A server component: nothing here is interactive, and the numbers are resolved
 * before the page renders.
 *
 * The ordering is the panel's argument. A creator's first question is not "how
 * is the account doing" -- that is the account manager's screen -- it is "what
 * needs me". So the counts that lead are the ones where the work is *stuck on
 * this person*: flagged items the engine refused, drafts nobody has submitted,
 * and pieces handed to them by a lead. Items already in review are shown last
 * and deliberately not styled as urgent: they are somebody else's move.
 */

export type CreatorCounts = {
  /** Refused by the engine. Somebody has to fix these before anything else. */
  flagged: number;
  /** Drafted or in refinement -- theirs to finish and submit. */
  inProgress: number;
  /** Handed to them by a content lead, and not yet submitted. */
  assigned: number;
  /** Submitted and waiting on a reviewer. Not their move. */
  awaitingReview: number;
};

export type ClientRow = {
  client_id: string;
  name: string;
  inProgress: number;
  flagged: number;
};

export function CreatorOverview({
  counts,
  clients,
  recentThreads,
}: {
  counts: CreatorCounts;
  clients: ClientRow[];
  recentThreads: { conversation_id: string; title: string | null; client_name: string }[];
}) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Flagged"
          value={counts.flagged}
          tone="flag"
          href="/Creator/assignments?flagged=1"
        />
        <Stat
          label="In progress"
          value={counts.inProgress}
          href="/Creator/assignments?status=drafted"
        />
        <Stat label="Assigned to you" value={counts.assigned} href="/Creator/assignments" />
        <Stat
          label="Awaiting review"
          value={counts.awaitingReview}
          href="/Creator/assignments?status=pending_internal_review"
          muted
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card title={`Your clients · ${clients.length}`}>
            {clients.length === 0 ? (
              <EmptyState>
                You are not assigned to any clients yet. An account manager or the agency admin
                assigns them.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-edge">
                {clients.map((client) => (
                  <li
                    key={client.client_id}
                    className="flex items-center justify-between gap-4 py-3"
                  >
                    <Link
                      href={`/Creator/assignments?client=${client.client_id}`}
                      className="min-w-0 text-sm font-medium text-heading hover:text-amber-dark"
                    >
                      {client.name}
                    </Link>
                    <div className="flex shrink-0 items-center gap-2">
                      {client.flagged > 0 ? (
                        <Badge tone="flag">{client.flagged} flagged</Badge>
                      ) : null}
                      <span className="text-xs text-body">{client.inProgress} in progress</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card title="Start writing">
          <p className="mb-3 text-sm text-body">
            Content starts in a conversation. The engine works from the client&rsquo;s brand guide
            and the agency standards.
          </p>
          <Link
            href="/Creator/chat"
            className="inline-block rounded-xl bg-amber-brand px-4 py-2 text-sm font-semibold text-ink"
          >
            New conversation
          </Link>

          {recentThreads.length > 0 ? (
            <ul className="mt-4 space-y-1 border-t border-edge pt-3">
              {recentThreads.map((thread) => (
                <li key={thread.conversation_id}>
                  <Link
                    href={`/Creator/chat/${thread.conversation_id}`}
                    className="block truncate text-xs text-body hover:text-amber-dark"
                  >
                    {thread.title ?? "Untitled"} · {thread.client_name}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  href,
  tone,
  muted,
}: {
  label: string;
  value: number;
  href?: string;
  tone?: "flag";
  /** Shown, but not as something demanding action -- it is somebody else's move. */
  muted?: boolean;
}) {
  const body = (
    <div
      className={[
        "rounded-2xl border p-4",
        tone === "flag" && value > 0
          ? "border-flag/30 bg-flag-bg"
          : "border-edge bg-surface",
      ].join(" ")}
    >
      <p className={`text-xs font-semibold ${muted ? "text-body" : "text-heading"}`}>{label}</p>
      <p
        className={`mt-1 font-heading text-3xl font-semibold ${
          tone === "flag" && value > 0 ? "text-flag" : muted ? "text-body" : "text-heading"
        }`}
      >
        {value}
      </p>
    </div>
  );

  return href ? (
    <Link href={href} className="block hover:opacity-90">
      {body}
    </Link>
  ) : (
    body
  );
}
