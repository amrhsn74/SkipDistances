"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { CreatorItemSerialized } from "@/domain/creatorQueue";

/**
 * Editing a draft in place.
 *
 * A textarea and a save button, and one thing worth more than either: it warns
 * **before** the save, not after, when the item has approvals to lose. An edit
 * runs the same invalidation a regeneration or a late decline does -- reset to
 * `drafted`, both stages clear again -- and a creator fixing a typo on an
 * approved post should know that costs the client's sign-off before they spend
 * it, not discover it from a status badge afterwards.
 *
 * The warning is drawn from the item's status alone, which is the same thing the
 * server decides on. It is an affordance, not a guard: `editDraft` applies the
 * reset regardless of what was shown here.
 */

/** Statuses at which saving would invalidate approvals already given. */
const COSTS_APPROVALS = new Set([
  "internal_approved",
  "pending_client_review",
  "client_approved",
  "scheduled",
]);

export function DraftEditor({ item }: { item: CreatorItemSerialized }) {
  const router = useRouter();

  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(item.content_body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ status: string; resetApprovals: boolean } | null>(null);

  const wouldReset = COSTS_APPROVALS.has(item.status);
  const dirty = body !== (item.content_body ?? "");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(null);

    const response = await fetch(`/api/content-items/${item.content_item_id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content_body: body }),
    });

    const result = (await response.json().catch(() => ({}))) as {
      status?: string;
      reset_approvals?: boolean;
      error?: { message?: string; issues?: Record<string, string> };
    };

    if (!response.ok) {
      setError(
        result.error?.issues?.contentBody ?? result.error?.message ?? "That could not be saved.",
      );
      setBusy(false);
      return;
    }

    setBusy(false);
    setEditing(false);
    setSaved({ status: result.status ?? "drafted", resetApprovals: Boolean(result.reset_approvals) });
    router.refresh();
  }

  async function submit() {
    setBusy(true);
    setError(null);

    const response = await fetch(`/api/content-items/${item.content_item_id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "submit" }),
    });

    if (!response.ok) {
      const result = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      setError(result.error?.message ?? "That could not be submitted.");
      setBusy(false);
      return;
    }

    setBusy(false);
    router.refresh();
  }

  if (!editing) {
    return (
      <div className="mt-4">
        <p className="whitespace-pre-wrap rounded-xl bg-canvas px-4 py-3 text-sm text-heading">
          {item.content_body ?? "No caption text — this is a brief for a visual deliverable."}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="skip-btn skip-btn-secondary"
          >
            Edit draft
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="skip-btn skip-btn-primary"
          >
            {busy ? "Sending…" : "Send to review"}
          </button>

          {saved ? (
            <p role="status" className="text-sm text-body">
              Saved.{" "}
              {saved.resetApprovals
                ? "Approvals were cleared — this is back to a draft."
                : "Still a draft."}
            </p>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form onSubmit={save} className="mt-4">
      {wouldReset ? (
        <p className="mb-3 rounded-lg bg-flag-bg px-3 py-2 text-sm text-flag">
          {/*
            Before the save, not after. An edit is one of the three
            invalidations, and a creator should spend a client's sign-off
            knowingly rather than find out from a badge they were not watching.
          */}
          This post has already been approved. Saving a change sends it back to a
          draft, and both review stages have to clear again.
        </p>
      ) : null}

      <label htmlFor={`draft-${item.content_item_id}`} className="skip-label">
        Draft text
      </label>
      <textarea
        id={`draft-${item.content_item_id}`}
        rows={6}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="skip-input resize-y font-sans"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy || !dirty} className="skip-btn skip-btn-primary">
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => {
            setBody(item.content_body ?? "");
            setEditing(false);
            setError(null);
          }}
          disabled={busy}
          className="skip-btn skip-btn-secondary"
        >
          Cancel
        </button>
        {!dirty ? <p className="text-sm text-body/70">Nothing changed yet.</p> : null}
      </div>

      {error ? (
        <p role="alert" className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}
