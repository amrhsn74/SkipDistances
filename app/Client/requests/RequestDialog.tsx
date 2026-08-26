"use client";

import { useState } from "react";

/**
 * Asking for a post on a particular day.
 *
 * The whole dialog rests on one sentence of copy, and it is the sentence rather
 * than the form that matters: **a request is not a schedule.** From the PRD, a
 * `PostRequest` "is a starting point for a real campaign, not a shortcut around
 * one" -- an account manager still has to convert it into a brief that goes
 * through the same guarded engine and the same two approvals as anything else.
 *
 * Saying so here is what keeps the gate from being eroded by expectation. A
 * client who believes this books a slot will read the account manager's later
 * conversion as an obstacle rather than the process; a client told plainly what
 * this does will not.
 *
 * The comment is stored as a real `Comment` row on the request, so the client
 * and their account manager share one thread from the first message onward.
 * Bypass language in it is flagged for the Admin and changes nothing at all --
 * Clause 0.3's two halves.
 */
export function RequestDialog({
  date,
  onClose,
  onSaved,
}: {
  /** The day being asked for, as `YYYY-MM-DD`. */
  date: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const response = await fetch("/api/post-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // No `client_id`. The route derives it from the session -- a client id in
      // the body would be a value the browser controls deciding whose calendar
      // this lands on.
      body: JSON.stringify({ requested_date: date, comment }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string; issues?: Record<string, string> };
      };
      setError(
        body.error?.issues?.requestedDate ??
          body.error?.issues?.comment ??
          body.error?.message ??
          "That request could not be sent.",
      );
      setBusy(false);
      return;
    }

    setBusy(false);
    onSaved();
  }

  const readable = new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="request-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-edge bg-surface p-6 shadow-lg"
        // The backdrop closes; a click inside must not bubble up to it.
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="request-title" className="font-heading text-lg font-semibold text-heading">
          Ask for a post
        </h2>
        <p className="mt-1 text-sm text-body">{readable}</p>

        <form onSubmit={submit} className="mt-4">
          <label htmlFor="request-comment" className="skip-label">
            What would you like?
          </label>
          <textarea
            id="request-comment"
            required
            rows={4}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Something for the new opening — whatever you think works."
            className="skip-input resize-y"
          />

          <p className="mt-2 rounded-lg bg-canvas px-3 py-2 text-xs text-body">
            {/*
              The load-bearing sentence. Told before they send it, so the
              account manager's conversion reads as the process rather than an
              obstacle.
            */}
            This asks your account manager for a post — it does not schedule one.
            They turn it into a brief, the content is drafted against your brand
            guide, and it still comes back to you to approve.
          </p>

          {error ? (
            <p role="alert" className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
              {error}
            </p>
          ) : null}

          <div className="mt-4 flex items-center gap-2">
            <button type="submit" disabled={busy} className="skip-btn skip-btn-primary">
              {busy ? "Sending…" : "Send request"}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="skip-btn skip-btn-secondary"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
