"use client";

import { useState } from "react";

import { ClauseList } from "../ClauseList";
import type { ScopedClause } from "@/domain/retrievalScope";

/**
 * The client's own brand guide, on the thread it applies to.
 *
 * Here rather than in the nav because a brand rule only means something once you
 * know whose it is. A nav page listing every assigned client's guide at once
 * asks the reader to first find the right client, which is a question the thread
 * has already answered -- it is scoped to one client by construction.
 *
 * Collapsed by default. A creator arrives to write, not to read, and a guide
 * open above the transcript would push the conversation down the screen every
 * time they returned to a thread. Open, it is the same list the agency standards
 * page renders, so the two read identically.
 */
export function ClientGuidePanel({
  clientName,
  clauses,
}: {
  clientName: string;
  clauses: ScopedClause[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-2xl border border-edge bg-surface">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left"
      >
        <span className="min-w-0">
          <span className="block font-heading text-sm font-semibold text-heading">
            {clientName}&rsquo;s brand guide
          </span>
          <span className="block text-xs text-body">
            {clauses.length === 0
              ? // A real and common state: most of the roster has no guide of
                // its own and is governed by the agency standards alone.
                "No brand guide on file — the agency standards apply."
              : `${clauses.length} rule${clauses.length === 1 ? "" : "s"} every draft here is written under.`}
          </span>
        </span>
        {clauses.length > 0 ? (
          <span className="shrink-0 text-xs font-semibold text-amber-dark">
            {open ? "Hide" : "Show"}
          </span>
        ) : null}
      </button>

      {open && clauses.length > 0 ? (
        <div className="max-h-64 overflow-y-auto border-t border-edge px-4 py-3">
          <ClauseList clauses={clauses} />
        </div>
      ) : null}
    </div>
  );
}
