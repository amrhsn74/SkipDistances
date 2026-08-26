"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ReviewItemView } from "./ReviewItemCard";

/**
 * Approve and decline, on one item.
 *
 * Both go to the same endpoint, because they are the same action at the domain
 * layer -- an `Approval` row and a re-run of the status machine. This component
 * does not decide what a decision means; it collects one and posts it.
 *
 * The one rule it enforces in the browser is the decline comment, and it does so
 * knowing the server enforces it too. `recordDecision` rejects a comment-less
 * decline with a field-keyed error regardless of what is typed here -- this is
 * the affordance, not the guard. A declined item bounced back to its author with
 * no explanation is an item whose author cannot act on the rejection, so asking
 * before the round trip is worth the duplication.
 *
 * On success it calls `router.refresh()` rather than mutating local state. The
 * queue is a server-rendered, scoped read; re-running it is what keeps the
 * screen agreeing with the database about a status that may have moved further
 * than this one decision (an approval that completed a stage, an item that left
 * the queue entirely).
 */

export type DecisionOutcome = {
  status: string;
  gate: { allowed: boolean; blocked_by: string[] };
  late_revoke: boolean;
  unscheduled: boolean;
};

export function DecisionActions({
  item,
  stage,
  /**
   * Rendered in place of the plain decline button when this decision would pull
   * back an approval already given. Supplied by `P6.4`; without it a late
   * decline still works, it just does not ask twice.
   */
  renderRevoke,
}: {
  item: ReviewItemView;
  stage: "internal" | "client";
  renderRevoke?: (props: {
    busy: boolean;
    onConfirm: (comment: string) => Promise<void>;
  }) => React.ReactNode;
}) {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decliningOpen, setDecliningOpen] = useState(false);
  const [comment, setComment] = useState("");

  async function decide(decision: "approve" | "decline", withComment: string | null) {
    setBusy(true);
    setError(null);

    const response = await fetch(`/api/content-items/${item.content_item_id}/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `decidedById` is deliberately not sent. The route records the decision
      // against the session user and refuses a body that names anyone else, so
      // supplying it here could only ever be wrong or redundant.
      body: JSON.stringify({ stage, decision, comment: withComment }),
    });

    const body = (await response.json().catch(() => ({}))) as {
      error?: { message?: string; issues?: Record<string, string> };
    };

    if (!response.ok) {
      setError(
        body.error?.issues?.comment ??
          body.error?.message ??
          "That decision could not be recorded.",
      );
      setBusy(false);
      return;
    }

    setDecliningOpen(false);
    setComment("");
    setBusy(false);
    router.refresh();
  }

  const revoke = renderRevoke?.({
    busy,
    onConfirm: (withComment: string) => decide("decline", withComment),
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {/*
          Approve is offered only where it is legal. The status machine allows an
          approval solely at this stage's own pending status -- approving
          something already approved is refused with a 409 -- so a button
          rendered on an approved item could do nothing but fail. Withdrawing is
          the only decision left there, and it is the one shown.
        */}
        {item.awaiting_me ? (
          <button
            type="button"
            onClick={() => decide("approve", null)}
            disabled={busy}
            className="skip-btn skip-btn-primary"
          >
            {busy ? "Recording…" : "Approve"}
          </button>
        ) : null}

        {revoke ?? (
          <button
            type="button"
            onClick={() => setDecliningOpen((open) => !open)}
            disabled={busy}
            className="skip-btn skip-btn-secondary"
            aria-expanded={decliningOpen}
          >
            Decline
          </button>
        )}

        <p className="ml-auto text-sm text-body">{waitingOn(item, stage)}</p>
      </div>

      {decliningOpen ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void decide("decline", comment);
          }}
          className="rounded-xl border border-edge bg-canvas p-4"
        >
          <label htmlFor={`decline-${item.content_item_id}`} className="skip-label">
            What needs fixing?
          </label>
          <textarea
            id={`decline-${item.content_item_id}`}
            required
            rows={3}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="A sentence the person who wrote this can act on."
            className="skip-input resize-y"
          />
          <p className="mt-1 text-xs text-body/70">
            This goes back to whoever is working on it, as a draft — not into the
            reviewer&rsquo;s queue again.
          </p>

          <div className="mt-3 flex items-center gap-2">
            <button type="submit" disabled={busy} className="skip-btn skip-btn-primary">
              {busy ? "Recording…" : "Send back"}
            </button>
            <button
              type="button"
              onClick={() => setDecliningOpen(false)}
              className="skip-btn skip-btn-secondary"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What this item is currently waiting on, in words.
 *
 * Read from the standing decisions rather than the status, for the same reason
 * the gate is: the status is a summary, the decisions are the record. They agree
 * in normal operation, and where they would not, the decisions are the half the
 * scheduler will act on.
 */
function waitingOn(item: ReviewItemView, stage: "internal" | "client"): string {
  if (item.awaiting_me) return "Waiting on you.";

  const other = stage === "internal" ? item.decisions.client : item.decisions.internal;
  const otherLabel = stage === "internal" ? "the client" : "internal review";

  if (other === null) return `Waiting on ${otherLabel}.`;
  if (other.decision === "approve") return "Both stages are in.";
  return `Declined at ${otherLabel}.`;
}
