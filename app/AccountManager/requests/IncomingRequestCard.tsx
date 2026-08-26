"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Avatar, AvatarName } from "../../components/Avatar";
import { Badge, type BadgeTone } from "../../components/Page";
import type { IncomingRequestSerialized } from "@/domain/clientCalendar";

/**
 * One incoming request, and the three things an account manager can do with it.
 *
 * **Take for review** is a visible action, not a side effect of opening this
 * page. It is what closes the client's edit window, so it has to be something
 * the manager deliberately does -- a window that closed because someone glanced
 * at a list would leave a client unable to fix their own date with nothing on
 * screen explaining when that happened, or why.
 *
 * **Convert** is the only path to real work, and it is not a shortcut. It calls
 * `submitBrief` -- the same function `POST /api/campaigns` calls -- so a
 * converted request runs the identical guarded engine and the identical two
 * approvals as a brief typed by hand. The request supplies the starting text and
 * nothing else; it carries no authority, however the client worded it.
 *
 * That is why the brief text is an editable field here rather than the client's
 * comment posted straight through. The manager writes the brief; the client's
 * words are context for writing it.
 */

const STATUS: Record<string, { tone: BadgeTone; label: string }> = {
  new: { tone: "info", label: "New" },
  under_review: { tone: "flag", label: "You have this" },
  converted: { tone: "ok", label: "Converted" },
  declined: { tone: "danger", label: "Declined" },
  withdrawn: { tone: "neutral", label: "Withdrawn by the client" },
};

export function IncomingRequestCard({ request }: { request: IncomingRequestSerialized }) {
  const router = useRouter();

  const [converting, setConverting] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [briefText, setBriefText] = useState(() => openingComment(request));
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = STATUS[request.status] ?? {
    tone: "neutral" as BadgeTone,
    label: request.status,
  };

  async function act(body: unknown) {
    setBusy(true);
    setError(null);

    const response = await fetch(`/api/post-requests/${request.post_request_id}/convert`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as {
        error?: { message?: string; issues?: Record<string, string> };
      };
      setError(
        result.error?.issues?.rawBriefText ?? result.error?.message ?? "That could not be done.",
      );
      setBusy(false);
      return;
    }

    setBusy(false);
    setConverting(false);
    setDeclining(false);
    router.refresh();
  }

  const readable = new Date(request.requested_date).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  const open = request.status === "new" || request.status === "under_review";

  return (
    <article className="rounded-2xl border border-edge bg-surface p-5 shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Avatar
            userId={request.requested_by_id}
            name={request.requested_by_name}
            // Only a client contact may raise a request, so the role is known
            // here without a lookup.
            role="client_contact"
            size="lg"
          />
          <div className="min-w-0">
            <h3 className="font-heading text-base font-semibold text-heading">
              {request.client_name}
            </h3>
            <p className="mt-0.5 text-sm text-body">
              Asking for {readable}
              {request.requested_by_name ? ` · raised by ${request.requested_by_name}` : ""}
            </p>
          </div>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </header>

      {request.comments.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {request.comments.map((comment) => (
            <li key={comment.comment_id} className="rounded-xl bg-canvas px-4 py-3">
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-body/70">
                <AvatarName userId={comment.author_id} name={comment.author_name} />
                · {new Date(comment.created_at).toLocaleString()}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-heading">{comment.body}</p>
            </li>
          ))}
        </ul>
      ) : null}

      {request.related_content_item_id ? (
        <p className="mt-3 text-sm text-body">
          This is a change to an existing post, not a new one.
        </p>
      ) : null}

      {open ? (
        <div className="mt-4 border-t border-edge pt-4">
          {converting ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act({ raw_brief_text: briefText, title: title || null });
              }}
            >
              <p className="mb-3 rounded-lg bg-canvas px-3 py-2 text-sm text-body">
                {/*
                  Said where the conversion happens, because this is the exact
                  point a request could be mistaken for a shortcut. It is not:
                  the same engine, the same two approvals.
                */}
                This runs the same guarded engine as a brief you type yourself, and
                the result still needs both approvals. The client&rsquo;s wording is
                context for the brief, never authority over it.
              </p>

              <label htmlFor={`title-${request.post_request_id}`} className="skip-label">
                Campaign title <span className="font-normal text-body/70">(optional)</span>
              </label>
              <input
                id={`title-${request.post_request_id}`}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Leave blank and one is derived from the brief."
                className="skip-input"
              />

              <label
                htmlFor={`brief-${request.post_request_id}`}
                className="skip-label mt-3"
              >
                The brief
              </label>
              <textarea
                id={`brief-${request.post_request_id}`}
                required
                rows={6}
                value={briefText}
                onChange={(e) => setBriefText(e.target.value)}
                className="skip-input resize-y"
              />

              <div className="mt-3 flex items-center gap-2">
                <button type="submit" disabled={busy} className="skip-btn skip-btn-primary">
                  {busy ? "Running the engine…" : "Convert to a campaign"}
                </button>
                <button
                  type="button"
                  onClick={() => setConverting(false)}
                  disabled={busy}
                  className="skip-btn skip-btn-secondary"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : declining ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act({ action: "decline", reason });
              }}
            >
              <label htmlFor={`reason-${request.post_request_id}`} className="skip-label">
                Why not?
              </label>
              <textarea
                id={`reason-${request.post_request_id}`}
                required
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="The client reads this, so make it something they can act on."
                className="skip-input resize-y"
              />
              <div className="mt-3 flex items-center gap-2">
                <button type="submit" disabled={busy} className="skip-btn skip-btn-primary">
                  {busy ? "Sending…" : "Decline"}
                </button>
                <button
                  type="button"
                  onClick={() => setDeclining(false)}
                  className="skip-btn skip-btn-secondary"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {request.status === "new" ? (
                <button
                  type="button"
                  onClick={() => act({ action: "start_review" })}
                  disabled={busy}
                  className="skip-btn skip-btn-primary"
                >
                  {busy ? "Taking…" : "Take for review"}
                </button>
              ) : null}

              <button
                type="button"
                onClick={() => setConverting(true)}
                disabled={busy}
                className="skip-btn skip-btn-secondary"
              >
                Convert to a campaign
              </button>
              <button
                type="button"
                onClick={() => setDeclining(true)}
                disabled={busy}
                className="skip-btn skip-btn-secondary text-danger"
              >
                Decline
              </button>

              {request.status === "new" ? (
                <p className="ml-auto text-sm text-body/70">
                  The client can still change this until you take it.
                </p>
              ) : null}
            </div>
          )}
        </div>
      ) : request.linked_campaign_id ? (
        <p className="mt-4 border-t border-edge pt-4 text-sm text-body">
          Converted into a campaign, which is in your briefs queue.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </article>
  );
}

/**
 * The client's first message, as the starting text for the brief.
 *
 * A starting point the manager edits, not the brief itself. The distinction is
 * the whole design of `PostRequest`: posting the client's words through
 * unchanged would make the request the brief, which is exactly the authority it
 * is not supposed to carry.
 */
function openingComment(request: IncomingRequestSerialized): string {
  return request.comments[0]?.body ?? "";
}
