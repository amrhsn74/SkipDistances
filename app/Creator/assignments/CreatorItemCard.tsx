"use client";

import { Badge, type BadgeTone } from "../../components/Page";
import type { CreatorItemSerialized } from "@/domain/creatorQueue";
import { flagMessage } from "@/domain/flagMessages";

/**
 * One item on a creator's desk.
 *
 * Deliberately a different card from the reviewer's. A reviewer reads a finished
 * draft and decides; a creator reads an unfinished one and changes it, so what
 * this leads with is the work -- the body, editable in place -- and what the
 * reviewer's card leads with is the standing decisions.
 *
 * The one thing both insist on is the citation line, for the same reason: a
 * draft that names no rule it was written under is worth noticing.
 *
 * Where an item is flagged, the clause's **full text** is shown rather than its
 * code. A creator fixing a flagged draft needs to know what the rule says, and
 * sending them to another screen to look up `1.3` is how a flag gets worked
 * around instead of addressed.
 */

const STATUS_TONE: Record<string, BadgeTone> = {
  drafted: "neutral",
  in_refinement: "info",
  flagged: "flag",
  pending_internal_review: "info",
};

const STATUS_LABEL: Record<string, string> = {
  drafted: "Drafted",
  in_refinement: "In refinement",
  flagged: "Flagged",
  pending_internal_review: "With the reviewer",
};

export function CreatorItemCard({
  item,
  editor,
  regenerate,
  history,
}: {
  item: CreatorItemSerialized;
  /** The inline edit control, where a screen offers one. */
  editor?: React.ReactNode;
  /** The regenerate prompt + file picker. */
  regenerate?: React.ReactNode;
  /** The reference/version history for this item. */
  history?: React.ReactNode;
}) {
  return (
    <article className="rounded-2xl border border-edge bg-surface p-5 shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3">
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

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge>{item.content_form}</Badge>
          <Badge tone={STATUS_TONE[item.status] ?? "neutral"}>
            {STATUS_LABEL[item.status] ?? item.status}
          </Badge>
        </div>
      </header>

      {item.flagged_clause ? (
        <div className="mt-4 rounded-xl border border-flag/30 bg-flag-bg px-4 py-3">
          {/* The plain-language explanation first, the rule's own text second.
              A creator's next question is "what do I change", and a clause code
              answers it with a lookup task. Same sentence the chat gave them and
              the Admin would read -- see `lib/domain/flagMessages.ts`. */}
          <p className="text-sm font-semibold text-flag">
            {flagMessage(
              item.flagged_clause.source_type === "agency"
                ? "compliance_violation"
                : "brand_violation",
              {
                clauseCode: item.flagged_clause.clause_code,
                clauseTitle: item.flagged_clause.title,
                clientName: item.client_name,
              },
            )}
          </p>
          <p className="mt-2 whitespace-pre-wrap text-sm text-body">
            {item.flagged_clause.text}
          </p>
          {/* Said before the button, not after it. Submitting past a flag is the
              act that puts a row in front of the Agency Admin, and a creator
              should know that before they choose it rather than discover it. */}
          <p className="mt-2 text-xs text-flag">
            Edit it to clear this. Submitting it as it stands is recorded for the
            agency admin.
          </p>
        </div>
      ) : null}

      {editor ?? (
        <p className="mt-4 whitespace-pre-wrap rounded-xl bg-canvas px-4 py-3 text-sm text-heading">
          {item.content_body ?? "No caption text — this is a brief for a visual deliverable."}
        </p>
      )}

      {item.citations.length > 0 ? (
        <div className="mt-3">
          <p className="skip-label mb-1.5 text-body">Grounded in</p>
          <ul className="flex flex-wrap gap-1.5">
            {item.citations.map((c) => (
              <li key={c.clause_id}>
                <span
                  title={c.title}
                  className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-canvas px-2 py-1 text-xs text-body"
                >
                  <span className="font-semibold text-heading">{c.clause_code}</span>
                  <span className="max-w-[16rem] truncate">{c.title}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-3 text-sm text-flag">
          No clause cited — this draft names no rule it was written under.
        </p>
      )}

      {!item.editable ? (
        <p className="mt-3 rounded-lg bg-canvas px-3 py-2 text-sm text-body">
          {/*
            Editing under a reviewer mid-decision would reset the item beneath
            them. The card still shows the work -- a creator who submitted an
            hour ago should see where it went -- but the controls are gone.
          */}
          This is with the reviewer. Editing it now would pull it back out of their
          queue, so the controls are off until they answer.
        </p>
      ) : (
        <>
          {regenerate ? <div className="mt-4 border-t border-edge pt-4">{regenerate}</div> : null}
        </>
      )}

      {history ? <div className="mt-4 border-t border-edge pt-4">{history}</div> : null}
    </article>
  );
}
