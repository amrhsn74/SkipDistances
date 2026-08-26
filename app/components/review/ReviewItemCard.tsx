"use client";

import { Badge, type BadgeTone } from "../Page";

/**
 * One drafted item, as a reviewer reads it.
 *
 * The card is deliberately dumb: it renders a row and nothing else. Approve,
 * decline and revoke arrive as `actions`, so the same card serves the internal
 * reviewer, the client, and any later screen that wants to *show* an item
 * without offering a decision on it.
 *
 * What it does insist on is the citation line. The PRD's grounded-output
 * requirement is that a reviewer can see "why, not just what", and a card that
 * showed the caption alone would make the citations technically stored and
 * practically invisible. An item citing nothing renders the absence in words
 * rather than an empty space -- a draft with no rule behind it is exactly what a
 * reviewer should be able to notice at a glance.
 */

/** The serialised shape crossing the server/client boundary. */
export type ReviewItemView = {
  content_item_id: string;
  campaign_id: string;
  campaign_title: string;
  client_id: string;
  client_name: string;
  content_form: string;
  platform: string | null;
  content_body: string | null;
  status: string;
  /** ISO, because a Date crosses the boundary as a string anyway. */
  scheduled_date: string | null;
  market_name: string | null;
  created_at: string;
  citations: { clause_id: string; clause_code: string; title: string; source_type: string }[];
  comment_count: number;
  comments: { comment_id: string; author_name: string | null; body: string; created_at: string }[];
  decisions: {
    internal: DecisionView | null;
    client: DecisionView | null;
  };
  awaiting_me: boolean;
  late_revoke: boolean;
};

export type DecisionView = {
  decision: string;
  comment: string | null;
  decided_at: string;
  decided_by_name: string | null;
};

/**
 * Status colour by meaning, never by hue.
 *
 * `scheduled` is `info` rather than `ok` on purpose: a booked slot is a state,
 * not an achievement, and colouring it as success would read as "done" on the
 * one screen where it most needs to read as "still revocable".
 */
const STATUS_TONE: Record<string, BadgeTone> = {
  drafted: "neutral",
  in_refinement: "neutral",
  pending_internal_review: "info",
  internal_approved: "ok",
  pending_client_review: "info",
  client_approved: "ok",
  scheduled: "info",
  flagged: "flag",
  declined: "danger",
  publishing: "info",
  published: "ok",
  publish_failed: "danger",
};

export function statusTone(status: string): BadgeTone {
  return STATUS_TONE[status] ?? "neutral";
}

/** `pending_internal_review` reads badly in a badge; this is the label for it. */
const STATUS_LABEL: Record<string, string> = {
  drafted: "Drafted",
  in_refinement: "In refinement",
  pending_internal_review: "Awaiting internal review",
  internal_approved: "Internally approved",
  pending_client_review: "Awaiting client approval",
  client_approved: "Client approved",
  scheduled: "Scheduled",
  flagged: "Flagged",
  declined: "Declined",
  publishing: "Publishing",
  published: "Published",
  publish_failed: "Publish failed",
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

export function ReviewItemCard({
  item,
  /** Whose queue this card is being read in, for the "waiting on" line. */
  stage,
  /** Approve / decline / revoke, supplied by whichever screen offers them. */
  actions,
  /** The comment thread, when a screen chooses to show one. */
  thread,
  /** Bulk selection, when a screen offers it. Absent means no checkbox. */
  selection,
}: {
  item: ReviewItemView;
  stage: "internal" | "client";
  actions?: React.ReactNode;
  thread?: React.ReactNode;
  selection?: { checked: boolean; onChange: (checked: boolean) => void };
}) {
  const other = stage === "internal" ? item.decisions.client : item.decisions.internal;
  const mine = stage === "internal" ? item.decisions.internal : item.decisions.client;

  return (
    <article className="rounded-2xl border border-edge bg-surface p-5 shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {selection ? (
            <input
              type="checkbox"
              checked={selection.checked}
              onChange={(e) => selection.onChange(e.target.checked)}
              aria-label={`Select ${item.content_form} from ${item.campaign_title}`}
              className="mt-1 h-4 w-4 shrink-0 accent-[color:var(--skip-amber)]"
            />
          ) : null}
          <div className="min-w-0">
            <h3 className="truncate font-heading text-base font-semibold text-heading">
              {item.campaign_title}
            </h3>
            <p className="mt-0.5 text-sm text-body">
              {item.client_name}
              {item.market_name ? ` · ${item.market_name}` : ""}
              {item.platform ? ` · ${item.platform}` : ""}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge>{item.content_form}</Badge>
          <Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge>
        </div>
      </header>

      {item.content_body ? (
        <p className="mt-4 whitespace-pre-wrap rounded-xl bg-canvas px-4 py-3 text-sm text-heading">
          {item.content_body}
        </p>
      ) : (
        // Image, video, reel and photoshoot items carry their content through
        // MediaAsset rows rather than text, so an empty body is normal for them
        // and says so, rather than rendering as a blank panel.
        <p className="mt-4 rounded-xl border border-dashed border-edge px-4 py-3 text-sm text-body">
          No caption text — this {item.content_form} is a brief for a visual deliverable.
        </p>
      )}

      <Citations citations={item.citations} />

      <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
        <DecisionLine
          label={stage === "internal" ? "Internal" : "Client"}
          decision={mine}
          emphasis
        />
        <DecisionLine
          label={stage === "internal" ? "Client" : "Internal"}
          decision={other}
        />
      </dl>

      {item.scheduled_date ? (
        <p className="mt-3 text-sm text-body">
          Scheduled for{" "}
          <span className="font-semibold text-heading">
            {new Date(item.scheduled_date).toLocaleString()}
          </span>
        </p>
      ) : null}

      {actions ? <div className="mt-4 border-t border-edge pt-4">{actions}</div> : null}
      {thread ? <div className="mt-4 border-t border-edge pt-4">{thread}</div> : null}
    </article>
  );
}

/**
 * The rules this item was written under.
 *
 * Codes are shown with their titles rather than as bare `1.3`s: a reviewer
 * should not have to hold the agency handbook in their head to read a queue.
 */
function Citations({ citations }: { citations: ReviewItemView["citations"] }) {
  if (citations.length === 0) {
    return (
      <p className="mt-3 text-sm text-flag">
        No clause cited — this draft names no rule it was written under.
      </p>
    );
  }

  return (
    <div className="mt-3">
      <p className="skip-label mb-1.5 text-body">Grounded in</p>
      <ul className="flex flex-wrap gap-1.5">
        {citations.map((c) => (
          <li key={c.clause_id}>
            <span
              title={c.title}
              className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-canvas px-2 py-1 text-xs text-body"
            >
              <span className="font-semibold text-heading">{c.clause_code}</span>
              <span className="max-w-[16rem] truncate">{c.title}</span>
              {c.source_type === "agency" ? (
                <span className="text-body/60">agency</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One stage's standing decision, or the fact that there isn't one. */
function DecisionLine({
  label,
  decision,
  emphasis = false,
}: {
  label: string;
  decision: DecisionView | null;
  emphasis?: boolean;
}) {
  return (
    <div className={emphasis ? "rounded-lg bg-canvas px-3 py-2" : "px-3 py-2"}>
      <dt className="text-xs uppercase tracking-wide text-body/70">{label}</dt>
      <dd className="mt-0.5 text-sm">
        {decision === null ? (
          // Absence is not approval. Saying "no decision yet" rather than
          // leaving it blank is the gate's own reading, shown to a human.
          <span className="text-body">No decision yet</span>
        ) : (
          <>
            <span
              className={
                decision.decision === "approve"
                  ? "font-semibold text-ok"
                  : "font-semibold text-danger"
              }
            >
              {decision.decision === "approve" ? "Approved" : "Declined"}
            </span>{" "}
            <span className="text-body">
              by {decision.decided_by_name ?? "someone"} ·{" "}
              {new Date(decision.decided_at).toLocaleDateString()}
            </span>
            {decision.comment ? (
              <span className="mt-1 block text-body">“{decision.comment}”</span>
            ) : null}
          </>
        )}
      </dd>
    </div>
  );
}
