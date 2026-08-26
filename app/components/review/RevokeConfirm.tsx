"use client";

import { useState } from "react";

import type { ReviewItemView } from "./ReviewItemCard";

/**
 * Pulling back an approval that was already given.
 *
 * **This is UI only.** At the domain layer a late revoke is a decline like any
 * other -- the same `Approval` row, the same endpoint, the same reset to
 * `drafted`, the same unscheduling. `statusMachine` has no per-cause branching
 * and neither does `recordDecision`, and nothing here changes that. Adding a
 * second code path for the revoke is exactly how the two copies drift until one
 * forgets to release the slot.
 *
 * What this adds is a pause. The consequence differs from an ordinary decline in
 * what it costs a human, not in what it costs the database: an item at
 * `scheduled` has a date booked and a client who has already said yes, and
 * sending it back to `drafted` undoes both. A one-click decline on that row is a
 * mis-click that unwinds a week of sign-off, so the confirmation names what is
 * about to be undone before it asks for the comment.
 *
 * The two confirmations differ by exactly one sentence -- whether a booked slot
 * is being released -- because that is the only difference a reviewer needs to
 * weigh.
 */
export function RevokeConfirm({
  item,
  stage,
  busy,
  onConfirm,
}: {
  item: ReviewItemView;
  stage: "internal" | "client";
  busy: boolean;
  onConfirm: (comment: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");

  const isScheduled = item.status === "scheduled";
  const mine = stage === "internal" ? item.decisions.internal : item.decisions.client;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={busy}
        className="skip-btn skip-btn-secondary text-danger"
      >
        Withdraw approval
      </button>
    );
  }

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        await onConfirm(comment);
        setOpen(false);
        setComment("");
      }}
      className="w-full rounded-xl border border-danger/30 bg-danger-bg p-4"
    >
      <p className="font-heading text-sm font-semibold text-danger">
        {isScheduled
          ? "This post is already scheduled — are you sure?"
          : "You are withdrawing an approval you already gave."}
      </p>

      <ul className="mt-2 space-y-1 text-sm text-body">
        {isScheduled ? (
          <li>
            Its slot on{" "}
            <span className="font-semibold text-heading">
              {item.scheduled_date
                ? new Date(item.scheduled_date).toLocaleString()
                : "the calendar"}
            </span>{" "}
            is released. It will not publish.
          </li>
        ) : null}
        <li>
          The post goes back to <span className="font-semibold text-heading">drafted</span> for
          whoever is working on it.
        </li>
        <li>
          {/*
            Stated because it is the half people forget. A client_approved item
            keeps nothing: an internal approval given last week has to be given
            again, and a reviewer who expected only their own stage to clear
            would be surprised by that after the fact rather than before.
          */}
          <span className="font-semibold text-heading">Both stages</span> must clear again from
          the start — the other stage&rsquo;s approval does not survive this.
        </li>
        {mine ? (
          <li className="text-body/70">
            You approved this on {new Date(mine.decided_at).toLocaleDateString()}.
          </li>
        ) : null}
      </ul>

      <label htmlFor={`revoke-${item.content_item_id}`} className="skip-label mt-3">
        Why are you pulling it back?
      </label>
      <textarea
        id={`revoke-${item.content_item_id}`}
        required
        rows={3}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="A sentence the person who wrote this can act on."
        className="skip-input resize-y bg-surface"
      />

      <div className="mt-3 flex items-center gap-2">
        <button type="submit" disabled={busy} className="skip-btn skip-btn-primary">
          {busy ? "Recording…" : isScheduled ? "Unschedule and withdraw" : "Withdraw approval"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="skip-btn skip-btn-secondary"
        >
          Keep it approved
        </button>
      </div>
    </form>
  );
}
