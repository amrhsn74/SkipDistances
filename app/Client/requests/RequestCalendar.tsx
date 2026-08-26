"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { RequestDialog } from "./RequestDialog";

/**
 * A month of the client's own calendar, and the day they can ask for.
 *
 * A deliberately different grid from the account manager's. Theirs is a
 * scheduling tool -- clicking an item opens a time picker. This one is a
 * *request* surface: clicking a **day** asks for a post on it, and clicking an
 * existing post opens its thread. The two look alike and mean opposite things,
 * which is why they are not one component with a mode flag.
 *
 * Posts are placed on the day they publish in the client's own market timezone,
 * for the same reason the account manager's grid does it: a Riyadh post at 00:30
 * local is the previous evening in UTC, and a client shown the UTC day would see
 * a post landing on a day it never lands on for them.
 *
 * **Nothing here schedules anything.** A `PostRequest` carries no authority --
 * it is the front door to the same pipeline, not a bypass -- and the copy on the
 * dialog says so before the client types.
 */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export type CalendarPost = {
  content_item_id: string;
  campaign_title: string;
  content_form: string;
  status: string;
  scheduled_date: string;
  market_timezone: string | null;
};

export type CalendarRequest = {
  post_request_id: string;
  requested_date: string;
  status: string;
};

export function RequestCalendar({
  year,
  month,
  posts,
  requests,
}: {
  year: number;
  month: number;
  posts: CalendarPost[];
  requests: CalendarRequest[];
}) {
  const router = useRouter();
  const params = useSearchParams();

  const [requesting, setRequesting] = useState<string | null>(null);

  const postsByDay = new Map<number, CalendarPost[]>();
  for (const post of posts) {
    const day = localDayOfMonth(post.scheduled_date, post.market_timezone, year, month);
    if (day === null) continue;
    const bucket = postsByDay.get(day) ?? [];
    bucket.push(post);
    postsByDay.set(day, bucket);
  }

  const requestsByDay = new Map<number, CalendarRequest[]>();
  for (const request of requests) {
    // A requested *date* is a calendar day, not an instant -- the client asked
    // for "the 14th", not for 09:00 UTC on it. Read in UTC, which is how it was
    // stored from a date input.
    const date = new Date(request.requested_date);
    if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month) continue;
    const day = date.getUTCDate();
    const bucket = requestsByDay.get(day) ?? [];
    bucket.push(request);
    requestsByDay.set(day, bucket);
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
  const isCurrentMonth = today.getUTCFullYear() === year && today.getUTCMonth() + 1 === month;

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
          const dayPosts = postsByDay.get(day) ?? [];
          const dayRequests = requestsByDay.get(day) ?? [];
          const isToday = isCurrentMonth && today.getUTCDate() === day;
          const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

          return (
            <div key={day} className="group relative min-h-[104px] bg-surface p-1.5">
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
                {dayPosts.map((post) => (
                  <span
                    key={post.content_item_id}
                    title={`${post.campaign_title} — ${post.status}`}
                    className="block truncate rounded-md border-l-2 border-amber-brand bg-amber-brand/10 px-1.5 py-1 text-[11px] text-heading"
                  >
                    <span className="font-semibold">
                      {localTime(post.scheduled_date, post.market_timezone)}
                    </span>{" "}
                    {post.content_form}
                  </span>
                ))}

                {dayRequests.map((request) => (
                  <span
                    key={request.post_request_id}
                    title={`Your request — ${request.status}`}
                    className="block truncate rounded-md border-l-2 border-info bg-info-bg px-1.5 py-1 text-[11px] text-info"
                  >
                    Requested
                  </span>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setRequesting(iso)}
                aria-label={`Request a post on ${iso}`}
                // Hidden until hover or keyboard focus. A permanent "+" on every
                // one of thirty-one cells is visual noise on a calendar whose
                // job is to be read first and acted on second.
                className="absolute bottom-1.5 right-1.5 rounded-full bg-ink px-2 py-0.5 text-[11px] font-bold text-white opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
              >
                + Ask
              </button>
            </div>
          );
        })}
      </div>

      {requesting ? (
        <RequestDialog
          date={requesting}
          onClose={() => setRequesting(null)}
          onSaved={() => {
            setRequesting(null);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Which day of this month an instant falls on, in a given zone.
 *
 * Returns null when it falls outside the month being drawn -- which is the
 * whole reason this is computed per item rather than from the UTC date: an
 * instant late on the 31st in UTC can be the 1st of the next month in Riyadh,
 * and it belongs on neither grid cell of this one.
 */
function localDayOfMonth(
  iso: string,
  timeZone: string | null,
  year: number,
  month: number,
): number | null {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));

  const read = (type: string) => Number(parts.find((p) => p.type === type)?.value);

  if (read("year") !== year || read("month") !== month) return null;
  return read("day");
}

/** The publish time, in the market's own zone. */
function localTime(iso: string, timeZone: string | null): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timeZone ?? "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}
