"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge, EmptyState, type BadgeTone } from "../../components/Page";
import type { ClientCalendarSerialized } from "@/domain/clientCalendar";

/**
 * The client's own requests, with the controls that close when reviewing starts.
 *
 * PRD §6 answered the one open question here: a client **can** edit or withdraw
 * their own request, right up until an account manager takes it. Not a one-shot
 * submission -- a client who picked the wrong day should fix it themselves
 * rather than filing a second request and leaving the account manager to guess
 * which one is live.
 *
 * So the controls appear only while the request is `new`, and the row says why
 * they are gone once it moves. The window closing is an explicit action on the
 * account manager's side, not a side effect of them opening a page, which is
 * what makes "your account manager is looking at this now" a true statement
 * rather than a guess.
 *
 * `withdrawn` is shown as its own thing, never folded into `declined`. They are
 * different facts: declined is the agency saying no, withdrawn is the client
 * changing their mind, and a row that could not tell them apart would misreport
 * one party as the other.
 */

const STATUS: Record<string, { tone: BadgeTone; label: string }> = {
  new: { tone: "info", label: "Waiting to be picked up" },
  under_review: { tone: "info", label: "Your account manager is on it" },
  converted: { tone: "ok", label: "Turned into a campaign" },
  declined: { tone: "danger", label: "Declined" },
  withdrawn: { tone: "neutral", label: "You withdrew this" },
};

type RequestRow = ClientCalendarSerialized["requests"][number];

export function RequestList({ requests }: { requests: RequestRow[] }) {
  if (requests.length === 0) {
    return (
      <EmptyState>
        You have not asked for anything yet. Pick a day on the calendar above.
      </EmptyState>
    );
  }

  return (
    <ul className="space-y-4">
      {requests.map((request) => (
        <RequestRowItem key={request.post_request_id} request={request} />
      ))}
    </ul>
  );
}

function RequestRowItem({ request }: { request: RequestRow }) {
  const router = useRouter();

  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(request.requested_date.slice(0, 10));
  const [confirmingWithdraw, setConfirmingWithdraw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = STATUS[request.status] ?? {
    tone: "neutral" as BadgeTone,
    label: request.status,
  };

  async function send(body: unknown) {
    setBusy(true);
    setError(null);

    const response = await fetch(`/api/post-requests/${request.post_request_id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      // The 409 here is worth showing verbatim: "your account manager is
      // reviewing this request, so it can no longer be edited" tells a client
      // exactly what changed under them, which a generic failure would not.
      setError(result.error?.message ?? "That could not be saved.");
      setBusy(false);
      return;
    }

    setBusy(false);
    setEditing(false);
    setConfirmingWithdraw(false);
    router.refresh();
  }

  const readable = new Date(request.requested_date).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <li className="rounded-2xl border border-edge bg-surface p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-heading text-base font-semibold text-heading">{readable}</p>
          {request.related_content_item_id ? (
            <p className="mt-0.5 text-sm text-body">A change to an existing post.</p>
          ) : null}
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>

      {request.comments.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {request.comments.map((comment) => (
            <li key={comment.comment_id} className="rounded-xl bg-canvas px-4 py-3">
              <p className="text-xs text-body/70">
                {comment.author_name ?? "Someone"} ·{" "}
                {new Date(comment.created_at).toLocaleString()}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-heading">{comment.body}</p>
            </li>
          ))}
        </ul>
      ) : null}

      {request.client_editable ? (
        <div className="mt-4 border-t border-edge pt-4">
          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send({ requested_date: date });
              }}
            >
              <label htmlFor={`date-${request.post_request_id}`} className="skip-label">
                Move it to
              </label>
              <input
                id={`date-${request.post_request_id}`}
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="skip-input w-56"
              />
              <div className="mt-3 flex items-center gap-2">
                <button type="submit" disabled={busy} className="skip-btn skip-btn-primary">
                  {busy ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setDate(request.requested_date.slice(0, 10));
                  }}
                  className="skip-btn skip-btn-secondary"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : confirmingWithdraw ? (
            <div>
              <p className="text-sm text-body">
                {/*
                  Withdrawn rows are kept, not deleted -- their thread is part of
                  the client's conversation with their account manager. Saying so
                  stops "withdraw" reading as "delete".
                */}
                Withdrawing keeps this on record, marked withdrawn, so the
                conversation on it stays with your account manager.
              </p>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => send({ status: "withdrawn" })}
                  disabled={busy}
                  className="skip-btn skip-btn-primary"
                >
                  {busy ? "Withdrawing…" : "Withdraw it"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingWithdraw(false)}
                  className="skip-btn skip-btn-secondary"
                >
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="skip-btn skip-btn-secondary"
              >
                Change the day
              </button>
              <button
                type="button"
                onClick={() => setConfirmingWithdraw(true)}
                className="skip-btn skip-btn-secondary text-danger"
              >
                Withdraw
              </button>
              <p className="ml-auto text-sm text-body/70">
                You can change this until your account manager picks it up.
              </p>
            </div>
          )}
        </div>
      ) : request.status === "new" ? null : (
        <p className="mt-4 border-t border-edge pt-4 text-sm text-body">
          {request.status === "under_review"
            ? "Your account manager has this now, so it can no longer be changed here."
            : "This request is closed."}
        </p>
      )}

      {error ? (
        <p role="alert" className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}
