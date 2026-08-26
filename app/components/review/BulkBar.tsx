"use client";

/**
 * The bar that appears once something is selected.
 *
 * Deliberately not always visible. A permanently mounted "approve all" button is
 * an approve-all click away from a reviewer who meant to scroll -- and the whole
 * design commits to approvals being decisions rather than a formality. It shows
 * when a selection exists, says exactly how many items it covers, and names them
 * in the confirmation.
 */

export type BulkOutcome = {
  succeeded: number;
  failed: number;
  outcomes: { content_item_id: string; ok: boolean; message?: string }[];
};

export function BulkBar({
  selectedCount,
  totalCount,
  busy,
  result,
  onSelectAll,
  onClear,
  onApprove,
}: {
  selectedCount: number;
  totalCount: number;
  busy: boolean;
  result: BulkOutcome | null;
  onSelectAll: () => void;
  onClear: () => void;
  onApprove: () => void;
}) {
  return (
    <div className="mb-4 rounded-xl border border-edge bg-canvas px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-body">
          {selectedCount === 0 ? (
            <>Select items to approve them together.</>
          ) : (
            <>
              <span className="font-semibold text-heading">{selectedCount}</span> of {totalCount}{" "}
              selected
            </>
          )}
        </p>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onSelectAll}
            disabled={busy || selectedCount === totalCount}
            className="skip-btn skip-btn-secondary px-4 py-2 text-xs"
          >
            Select all on this page
          </button>

          {selectedCount > 0 ? (
            <button
              type="button"
              onClick={onClear}
              disabled={busy}
              className="skip-btn skip-btn-secondary px-4 py-2 text-xs"
            >
              Clear
            </button>
          ) : null}

          <button
            type="button"
            onClick={onApprove}
            disabled={busy || selectedCount === 0}
            className="skip-btn skip-btn-primary px-4 py-2 text-xs"
          >
            {busy
              ? "Recording…"
              : `Approve ${selectedCount || ""} ${selectedCount === 1 ? "item" : "items"}`.trim()}
          </button>
        </div>
      </div>

      {result ? (
        <p
          role="status"
          className={
            result.failed === 0
              ? "mt-3 rounded-lg bg-ok-bg px-3 py-2 text-sm text-ok"
              : "mt-3 rounded-lg bg-flag-bg px-3 py-2 text-sm text-flag"
          }
        >
          {/*
            Partial success is reported as partial success. A batch is not
            all-or-nothing -- an item that moved since the page was drawn fails
            on its own -- and rounding that to "done" would hide the one item a
            reviewer still has to look at.
          */}
          Recorded {result.succeeded} of {result.succeeded + result.failed}.
          {result.failed > 0 ? (
            <>
              {" "}
              {result.failed} could not be recorded:{" "}
              {result.outcomes
                .filter((o) => !o.ok)
                .map((o) => o.message)
                .filter((m, i, all) => all.indexOf(m) === i)
                .join(" ")}
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
