"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Badge, EmptyState } from "../../components/Page";
import { ScheduleDialog } from "./ScheduleDialog";

export type BoardItem = {
  content_item_id: string;
  campaign_id: string;
  campaign_title: string;
  client_id: string;
  client_name: string;
  content_form: string;
  platform: string | null;
  status: string;
  /** ISO instant, or null for an approved item with no slot yet. */
  scheduled_date: string | null;
  market_timezone: string | null;
  market_name: string | null;
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * A month of scheduled work.
 *
 * Each item is placed on the day it publishes **in its own market's timezone**,
 * not the reader's. A Riyadh post at 00:30 local is the previous evening in UTC,
 * and putting it on the UTC day would show an account manager a post landing on
 * a day the client will never see it on.
 */
export function MonthGrid({
  year,
  month,
  items,
}: {
  year: number;
  month: number;
  items: BoardItem[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [scheduling, setScheduling] = useState<BoardItem | null>(null);

  const scheduled = items.filter((i) => i.scheduled_date !== null);
  const unscheduled = items.filter((i) => i.scheduled_date === null);

  // Day-of-month → items, keyed in each item's own zone.
  const byDay = new Map<number, BoardItem[]>();
  for (const item of scheduled) {
    const day = localDayOfMonth(item.scheduled_date!, item.market_timezone, year, month);
    if (day === null) continue;
    const bucket = byDay.get(day) ?? [];
    bucket.push(item);
    byDay.set(day, bucket);
  }

  const firstOfMonth = new Date(Date.UTC(year, month - 1, 1));
  // Monday-first: JS gives Sunday as 0, so shift it to the end of the week.
  const leadingBlanks = (firstOfMonth.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  function goToMonth(deltaMonths: number) {
    const target = new Date(Date.UTC(year, month - 1 + deltaMonths, 1));
    const query = new URLSearchParams(params.toString());
    query.set("y", String(target.getUTCFullYear()));
    query.set("m", String(target.getUTCMonth() + 1));
    router.push(`?${query.toString()}`);
  }

  const today = new Date();
  const isCurrentMonth =
    today.getUTCFullYear() === year && today.getUTCMonth() + 1 === month;

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-heading text-xl font-semibold text-heading">
          {MONTH_NAMES[month - 1]} {year}
        </h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => goToMonth(-1)}
            className="skip-btn skip-btn-secondary px-4 py-1.5 text-xs"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() => goToMonth(1)}
            className="skip-btn skip-btn-secondary px-4 py-1.5 text-xs"
          >
            Next
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl border border-edge bg-edge">
        {WEEKDAYS.map((day) => (
          <div
            key={day}
            className="bg-canvas px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-body/70"
          >
            {day}
          </div>
        ))}

        {Array.from({ length: leadingBlanks }).map((_, i) => (
          <div key={`blank-${i}`} className="min-h-[104px] bg-canvas/50" />
        ))}

        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1;
          const dayItems = byDay.get(day) ?? [];
          const isToday = isCurrentMonth && today.getUTCDate() === day;

          return (
            <div key={day} className="min-h-[104px] bg-surface p-1.5">
              <span
                className={
                  isToday
                    ? "inline-flex h-6 w-6 items-center justify-center rounded-full bg-amber-brand text-xs font-bold text-ink"
                    : "inline-block px-1 text-xs font-semibold text-body/70"
                }
              >
                {day}
              </span>

              <div className="mt-1 space-y-1">
                {dayItems.map((item) => (
                  <button
                    key={item.content_item_id}
                    type="button"
                    onClick={() => setScheduling(item)}
                    title={`${item.campaign_title} — ${item.client_name}`}
                    className="block w-full truncate rounded-md border-l-2 border-amber-brand bg-amber-brand/10 px-1.5 py-1 text-left text-[11px] text-heading transition-colors hover:bg-amber-brand/25"
                  >
                    <span className="font-semibold">
                      {localTime(item.scheduled_date!, item.market_timezone)}
                    </span>{" "}
                    {item.client_name}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6">
        <h3 className="mb-2 font-heading text-base font-semibold text-heading">
          Approved, not yet scheduled
        </h3>
        {unscheduled.length === 0 ? (
          <EmptyState>Everything approved has a slot.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {unscheduled.map((item) => (
              <li
                key={item.content_item_id}
                className="flex items-center justify-between rounded-xl border border-edge bg-surface px-4 py-3 text-sm"
              >
                <span>
                  <span className="font-semibold text-heading">{item.campaign_title}</span>
                  <span className="ml-2 text-body/70">{item.client_name}</span>
                  <span className="ml-2">
                    <Badge tone="info">{item.content_form}</Badge>
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setScheduling(item)}
                  className="skip-btn skip-btn-primary px-4 py-1.5 text-xs"
                >
                  Schedule
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {scheduling ? (
        <ScheduleDialog
          item={scheduling}
          onClose={() => setScheduling(null)}
          onSaved={() => {
            setScheduling(null);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Which day of the displayed month an instant falls on, in its market's zone.
 *
 * Returns null when it falls outside the month once converted -- which genuinely
 * happens at the edges: a Riyadh post at 00:30 on the 1st is the previous
 * month in UTC, and the grid for that month has no square for it.
 */
function localDayOfMonth(
  iso: string,
  timeZone: string | null,
  year: number,
  month: number,
): number | null {
  const parts = zoneParts(new Date(iso), timeZone);
  if (parts.year !== year || parts.month !== month) return null;
  return parts.day;
}

/** The wall-clock time an instant reads as in its market's zone. */
function localTime(iso: string, timeZone: string | null): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timeZone ?? "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

function zoneParts(at: Date, timeZone: string | null) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);

  const read = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: read("year"), month: read("month"), day: read("day") };
}
