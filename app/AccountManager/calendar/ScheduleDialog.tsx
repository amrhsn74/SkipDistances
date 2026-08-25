"use client";

import { useState } from "react";

import type { BoardItem } from "./MonthGrid";

/**
 * Picking the exact moment an item publishes.
 *
 * The time is entered as **local to the item's market**, and the label says so.
 * A picker that silently meant the reader's own zone would send a Cairo post an
 * hour early for anyone working from Riyadh, and there would be nothing on
 * screen to reveal it.
 *
 * The conversion to an instant happens on the server, from the market's stored
 * timezone -- not here from the browser's, which is a fact about where the
 * manager happens to be sitting.
 */
export function ScheduleDialog({
  item,
  onClose,
  onSaved,
}: {
  item: BoardItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [localDateTime, setLocalDateTime] = useState(
    item.scheduled_date ? toLocalInputValue(item.scheduled_date, item.market_timezone) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const response = await fetch(`/api/content-items/${item.content_item_id}/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ local_date_time: localDateTime }),
    });

    const body = (await response.json()) as { error?: { message: string } };

    if (!response.ok) {
      setError(body.error?.message ?? "Could not schedule that.");
      setBusy(false);
      return;
    }

    onSaved();
  }

  async function release() {
    setBusy(true);
    setError(null);

    const response = await fetch(`/api/content-items/${item.content_item_id}/schedule`, {
      method: "DELETE",
    });

    if (!response.ok) {
      const body = (await response.json()) as { error?: { message: string } };
      setError(body.error?.message ?? "Could not unschedule that.");
      setBusy(false);
      return;
    }

    onSaved();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="schedule-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-edge bg-surface p-6 shadow-lg"
        // The backdrop closes; a click inside must not bubble up to it.
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="schedule-title" className="font-heading text-lg font-semibold text-heading">
          Schedule
        </h2>
        <p className="mt-1 text-sm text-body">
          {item.campaign_title} · {item.client_name}
        </p>

        <form onSubmit={save} className="mt-4 space-y-4">
          <div>
            <label htmlFor="publish-at" className="skip-label">
              Publish at{" "}
              <span className="font-normal text-body/70">
                ({item.market_name ?? "market"} local time)
              </span>
            </label>
            <input
              id="publish-at"
              type="datetime-local"
              required
              value={localDateTime}
              onChange={(e) => setLocalDateTime(e.target.value)}
              className="skip-input"
            />
            <p className="mt-1 text-xs text-body/70">
              {item.market_timezone
                ? `Stored as an exact instant in ${item.market_timezone}.`
                : "This item has no market, so the time is read as UTC."}
            </p>
          </div>

          {error ? (
            <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
              {error}
            </p>
          ) : null}

          <div className="flex items-center gap-2">
            <button type="submit" disabled={busy} className="skip-btn skip-btn-primary">
              {busy ? "Saving…" : "Save time"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="skip-btn skip-btn-secondary"
            >
              Cancel
            </button>

            {item.scheduled_date ? (
              <button
                type="button"
                onClick={release}
                disabled={busy}
                className="ml-auto text-sm font-semibold text-danger underline underline-offset-4 disabled:opacity-50"
              >
                Unschedule
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * An instant, as a `datetime-local` value in the market's zone.
 *
 * `datetime-local` has no timezone of its own -- it shows whatever string it is
 * given. Formatting in the market's zone is what makes the field agree with the
 * label above it.
 */
function toLocalInputValue(iso: string, timeZone: string | null): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));

  const read = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  // `en-CA` gives ISO-ish date parts, and hour can come back as "24" at
  // midnight in some engines.
  const hour = read("hour") === "24" ? "00" : read("hour");

  return `${read("year")}-${read("month")}-${read("day")}T${hour}:${read("minute")}`;
}
