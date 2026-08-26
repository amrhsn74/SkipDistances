"use client";

import { useState } from "react";

import { AvatarName } from "../Avatar";

/**
 * The discussion thread on one content item.
 *
 * Defined by what it does not do. A `Comment` is a message attached to a thing,
 * never a decision -- from the PRD: "a comment on a request or a post never
 * withdraws an approval or changes its status by itself; only a formal
 * approve/decline action, or a deliberate edit, does that."
 *
 * So this component posts to `/api/comments` and, on success, **does not call
 * `router.refresh()`** -- unlike every decision control on this screen. That is
 * not an oversight to be tidied up later: refreshing would re-read the item and
 * imply the page had something to reconsider, and the one thing worth showing a
 * reviewer here is that the badge above did not move. The new message is
 * appended locally because the only thing that changed is the thread.
 *
 * Bypass language typed in here is flagged for the Admin by `createComment` and
 * then changes nothing at all -- Clause 0.3's two halves, "noted, never obeyed",
 * with the second half visible on screen as a status that stays put.
 */

export type CommentView = {
  comment_id: string;
  author_id: string | null;
  author_name: string | null;
  body: string;
  created_at: string;
};

export function CommentThread({
  contentItemId,
  initialComments,
  /** The status shown on the card, echoed back so the no-op is visible. */
  statusLabel,
}: {
  contentItemId: string;
  initialComments: CommentView[];
  statusLabel: string;
}) {
  const [comments, setComments] = useState(initialComments);
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justPosted, setJustPosted] = useState(false);

  async function post(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const response = await fetch("/api/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content_item_id: contentItemId, body }),
    });

    const created = (await response.json().catch(() => ({}))) as CommentView & {
      error?: { message?: string; issues?: Record<string, string> };
    };

    if (!response.ok) {
      setError(created.error?.issues?.body ?? created.error?.message ?? "Could not post that.");
      setBusy(false);
      return;
    }

    // Appended locally. No refresh: nothing about the item changed, and
    // re-reading the page would suggest otherwise.
    setComments((current) => [...current, { ...created, author_name: "You" }]);
    setBody("");
    setBusy(false);
    setJustPosted(true);
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="text-sm font-semibold text-body underline underline-offset-4 transition-colors hover:text-heading"
      >
        {comments.length === 0
          ? "Add a comment"
          : `${comments.length} comment${comments.length === 1 ? "" : "s"}`}
      </button>

      {open ? (
        <div className="mt-3 space-y-3">
          {comments.length > 0 ? (
            <ul className="space-y-2">
              {comments.map((comment) => (
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

          <form onSubmit={post}>
            <label htmlFor={`comment-${contentItemId}`} className="skip-label">
              Add a comment
            </label>
            <textarea
              id={`comment-${contentItemId}`}
              required
              rows={2}
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setJustPosted(false);
              }}
              placeholder="A question, a note, anything worth saying out loud."
              className="skip-input resize-y"
            />
            <p className="mt-1 text-xs text-body/70">
              {/*
                Said before they type, not after. A client who believes a comment
                is how you decline will write "no, change this" and expect
                something to happen; telling them where the decision actually
                lives is what stops the gate being eroded by wording.
              */}
              A comment is a message, not a decision — it never approves,
              declines, or changes this post&rsquo;s status.
            </p>

            <div className="mt-2 flex items-center gap-2">
              <button type="submit" disabled={busy} className="skip-btn skip-btn-secondary">
                {busy ? "Posting…" : "Post comment"}
              </button>

              {justPosted ? (
                <p role="status" className="text-sm text-body">
                  Posted. This post is still{" "}
                  <span className="font-semibold text-heading">{statusLabel}</span>.
                </p>
              ) : null}
            </div>
          </form>

          {error ? (
            <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
