"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge, type BadgeTone } from "../../components/Page";
import type { GuideVersionSerialized } from "@/domain/brandGuideReview";

/**
 * One version of a client's brand guide, and the decision on it.
 *
 * The same two-sided shape as a content approval -- approve or decline, decline
 * needs a reason -- but a genuinely separate endpoint, because the two are
 * different facts. A content approval clears one post; approving a guide changes
 * what the engine grounds *every future draft* in. `approveBrandGuideVersion`
 * supersedes the outgoing version, promotes this one and repoints
 * `Client.active_brand_guide_id` in one transaction, so this button is the exact
 * moment a client's rules change.
 *
 * That is why the pending version is shown as a diff rather than as a document.
 * A client asked to approve a wall of clauses they have already read approves it
 * without reading; a client shown the three that changed reads those three.
 */

const STATUS: Record<string, { tone: BadgeTone; label: string }> = {
  draft: { tone: "neutral", label: "Draft with your account manager" },
  pending_client_approval: { tone: "info", label: "Waiting on you" },
  active: { tone: "ok", label: "In force" },
  superseded: { tone: "neutral", label: "Superseded" },
};

export function GuideVersionCard({ version }: { version: GuideVersionSerialized }) {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decliningOpen, setDecliningOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [expanded, setExpanded] = useState(version.awaiting_client);

  const status = STATUS[version.status] ?? { tone: "neutral" as BadgeTone, label: version.status };

  async function decide(decision: "approve" | "decline", withComment: string | null) {
    setBusy(true);
    setError(null);

    const response = await fetch(`/api/brand-guides/${version.brand_guide_version_id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, comment: withComment }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      setError(body.error?.message ?? "That decision could not be recorded.");
      setBusy(false);
      return;
    }

    setDecliningOpen(false);
    setComment("");
    setBusy(false);
    router.refresh();
  }

  const changed = version.clauses.filter((c) => c.change !== "unchanged");
  const showDiffOnly = version.awaiting_client && changed.length > 0;
  const visible = expanded ? version.clauses : showDiffOnly ? changed : [];

  return (
    <article
      className={
        version.awaiting_client
          ? "rounded-2xl border-2 border-amber-brand bg-surface p-5 shadow-sm"
          : "rounded-2xl border border-edge bg-surface p-5 shadow-sm"
      }
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-heading text-base font-semibold text-heading">
            Version {version.version_number}
          </h3>
          <p className="mt-0.5 text-sm text-body">
            Written by {version.created_by_name ?? "your account manager"} ·{" "}
            {new Date(version.created_at).toLocaleDateString()}
            {version.approved_at
              ? ` · approved ${new Date(version.approved_at).toLocaleDateString()}`
              : ""}
          </p>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </header>

      {showDiffOnly && !expanded ? (
        <p className="mt-3 text-sm text-body">
          {changed.length} {changed.length === 1 ? "rule differs" : "rules differ"} from the guide
          in force
          {version.removed_clause_codes.length > 0
            ? `, and ${version.removed_clause_codes.length} would be dropped`
            : ""}
          .
        </p>
      ) : null}

      {visible.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {visible.map((clause) => (
            <li
              key={clause.clause_id}
              className="rounded-xl border border-edge bg-canvas px-4 py-3"
            >
              <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-heading">
                <span>{clause.clause_code}</span>
                <span className="font-normal">{clause.title}</span>
                {clause.change === "added" ? <Badge tone="info">New</Badge> : null}
                {clause.change === "changed" ? <Badge tone="flag">Changed</Badge> : null}
              </p>
              <p className="mt-1.5 whitespace-pre-wrap text-sm text-body">{clause.text}</p>
              {clause.previous_text ? (
                <p className="mt-2 border-l-2 border-edge pl-3 text-sm text-body/70">
                  <span className="block text-xs uppercase tracking-wide">Currently</span>
                  {clause.previous_text}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {version.removed_clause_codes.length > 0 ? (
        <p className="mt-3 text-sm text-danger">
          Dropped: {version.removed_clause_codes.join(", ")}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        className="mt-3 text-sm font-semibold text-body underline underline-offset-4 transition-colors hover:text-heading"
      >
        {expanded
          ? "Show less"
          : `Read all ${version.clauses.length} ${version.clauses.length === 1 ? "rule" : "rules"}`}
      </button>

      {version.awaiting_client ? (
        <div className="mt-4 border-t border-edge pt-4">
          <p className="mb-3 text-sm text-body">
            {/*
              Said plainly because it is the consequence, and a client approving
              a document rarely thinks about the engine. Approving here changes
              what every future draft is written against.
            */}
            Approving replaces the guide in force. Everything drafted for you from
            then on is written against these rules.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => decide("approve", null)}
              disabled={busy}
              className="skip-btn skip-btn-primary"
            >
              {busy ? "Recording…" : "Approve this version"}
            </button>
            <button
              type="button"
              onClick={() => setDecliningOpen((open) => !open)}
              disabled={busy}
              className="skip-btn skip-btn-secondary"
              aria-expanded={decliningOpen}
            >
              Send back
            </button>
          </div>

          {decliningOpen ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void decide("decline", comment);
              }}
              className="mt-3 rounded-xl border border-edge bg-canvas p-4"
            >
              <label
                htmlFor={`decline-guide-${version.brand_guide_version_id}`}
                className="skip-label"
              >
                What needs changing?
              </label>
              <textarea
                id={`decline-guide-${version.brand_guide_version_id}`}
                required
                rows={3}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                className="skip-input resize-y"
              />
              <p className="mt-1 text-xs text-body/70">
                This goes back to your account manager as a draft. The guide in force
                does not change.
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
            <p role="alert" className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
