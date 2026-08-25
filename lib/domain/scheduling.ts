import { prisma, type Db } from "../db";
import { writeAudit } from "./auditLog";
import { canSchedule, type GateResult } from "./gate";
import { applyTransition } from "./statusMachine";

/**
 * Setting the exact moment an item publishes.
 *
 * The date the engine proposes is a *plan* -- a day, no time. This is where a
 * human turns that into a real slot: a wall-clock moment in the market the item
 * addresses. "Post before iftar" is 18:20 in Cairo and 17:50 in Riyadh on the
 * same evening, so a single UTC instant is the only thing worth storing and a
 * market timezone is the only way to compute it.
 *
 * The gate is asked, never assumed. `canSchedule` re-reads the approval rows
 * rather than trusting the item's status, because the status is a cache of those
 * rows and this is the operation that must not act on a stale one. Scheduling is
 * also *not* the last check: the Phase 9 scheduler re-runs the gate atomically
 * at publish time, and that check is the one that actually stops a publish.
 */

export class SchedulingError extends Error {
  readonly code = "SCHEDULING_REFUSED";
  readonly issues: Record<string, string>;

  constructor(issues: Record<string, string>) {
    super(Object.values(issues)[0] ?? "That cannot be scheduled.");
    this.name = "SchedulingError";
    this.issues = issues;
  }
}

/** Raised when the approval gate is closed. Carries which stage is missing. */
export class GateClosedError extends Error {
  readonly code = "GATE_CLOSED";
  readonly blockedBy: string[];

  constructor(blockedBy: string[]) {
    super(
      `Not approved yet — waiting on ${blockedBy.join(" and ")} approval.`,
    );
    this.name = "GateClosedError";
    this.blockedBy = blockedBy;
  }
}

export type ScheduleInput = {
  contentItemId: string;
  /**
   * The exact instant to publish, as an ISO string with an offset or `Z`.
   *
   * An offset is required rather than assumed. A bare "2026-09-01T19:00" is
   * ambiguous between two markets an hour apart, and guessing a zone here is
   * how an item goes out at the wrong hour with nothing in the record to
   * explain it -- the UI resolves the market's zone and sends an exact instant.
   */
  publishAt: string;
};

export type ScheduleResult = {
  contentItemId: string;
  scheduledFor: Date;
  previousStatus: string;
  status: string;
  gate: GateResult;
};

/** How far ahead a slot may be booked. Beyond this is almost always a typo. */
const MAX_HORIZON_DAYS = 365;

/**
 * Schedule an item for an exact moment.
 *
 * Refuses a past time. A slot behind `now` would be picked up by the scheduler's
 * very next tick and published immediately, which is never what someone setting
 * a time meant -- and is indistinguishable, afterwards, from having meant it.
 */
export async function scheduleItem(
  input: ScheduleInput,
  actorId: string,
  db: Db = prisma,
  now: Date = new Date(),
): Promise<ScheduleResult> {
  const item = await db.contentItem.findUnique({
    where: { content_item_id: input.contentItemId },
    select: { content_item_id: true, status: true },
  });
  if (!item) {
    throw new SchedulingError({ contentItemId: "No such content item." });
  }

  const when = parseInstant(input.publishAt);

  if (when.getTime() <= now.getTime()) {
    throw new SchedulingError({
      publishAt: "Pick a time in the future — a past slot would publish immediately.",
    });
  }

  const horizon = now.getTime() + MAX_HORIZON_DAYS * 86_400_000;
  if (when.getTime() > horizon) {
    throw new SchedulingError({
      publishAt: `That is more than ${MAX_HORIZON_DAYS} days out.`,
    });
  }

  // The gate, read fresh. Both stages must currently be approved -- a missing
  // decision blocks exactly as a decline does.
  const gate = await canSchedule(input.contentItemId, db);
  if (!gate.allowed) {
    throw new GateClosedError(gate.blockedBy);
  }

  const transition = applyTransition(item.status as never, {
    cause: "scheduled_date_change",
  });
  if (!transition.ok) {
    throw new SchedulingError({ status: transition.reason ?? `Cannot schedule from ${item.status}.` });
  }

  await db.contentItem.update({
    where: { content_item_id: input.contentItemId },
    data: { scheduled_date: when, status: "scheduled" },
  });

  await writeAudit(
    {
      entityType: "ContentItem",
      entityId: input.contentItemId,
      action: "scheduled",
      performedById: actorId,
      details: {
        scheduled_for: when.toISOString(),
        previous_status: item.status,
      },
    },
    db,
  );

  return {
    contentItemId: input.contentItemId,
    scheduledFor: when,
    previousStatus: item.status,
    status: "scheduled",
    gate,
  };
}

/**
 * Release a booked slot without touching the approvals.
 *
 * Distinct from a decline: the item stays approved, it simply has no time. The
 * difference matters because a decline resets the approval stages and this does
 * not -- an account manager moving a post off a bad date should not have to ask
 * the client to approve it again.
 */
export async function unscheduleItem(
  contentItemId: string,
  actorId: string,
  db: Db = prisma,
): Promise<{ contentItemId: string; status: string }> {
  const item = await db.contentItem.findUnique({
    where: { content_item_id: contentItemId },
    select: { status: true },
  });
  if (!item) throw new SchedulingError({ contentItemId: "No such content item." });

  if (item.status !== "scheduled") {
    throw new SchedulingError({
      status: `Only a scheduled item can be unscheduled; this is ${item.status}.`,
    });
  }

  // Back to `client_approved`, not to `drafted`. Both approvals still stand --
  // only the slot is given up.
  await db.contentItem.update({
    where: { content_item_id: contentItemId },
    data: { scheduled_date: null, status: "client_approved" },
  });

  await writeAudit(
    {
      entityType: "ContentItem",
      entityId: contentItemId,
      action: "edited",
      performedById: actorId,
      details: { unscheduled: true, previous_status: item.status },
    },
    db,
  );

  return { contentItemId, status: "client_approved" };
}

/**
 * An ISO instant, or a refusal.
 *
 * Requires an explicit offset. `new Date("2026-09-01T19:00")` is parsed in the
 * *server's* zone, which is a fact about where the process happens to run and
 * has nothing to do with the market the post is for.
 */
function parseInstant(raw: string): Date {
  const value = (raw ?? "").trim();
  if (!value) {
    throw new SchedulingError({ publishAt: "Pick a date and time." });
  }

  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    throw new SchedulingError({
      publishAt: "A publish time needs an explicit timezone offset.",
    });
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new SchedulingError({ publishAt: "That is not a valid date and time." });
  }

  return parsed;
}

/**
 * The UTC instant for a wall-clock time in a market's zone.
 *
 * The conversion the calendar UI needs: a person picks "1 September, 19:00" for
 * an Egyptian client and means 19:00 in Cairo. Uses `Intl` rather than a
 * hardcoded offset table, so daylight saving is handled by the platform's
 * timezone database instead of by an assumption that goes stale.
 */
export function instantForZone(
  localDateTime: string,
  timeZone: string,
): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(localDateTime.trim());
  if (!match) {
    throw new SchedulingError({
      publishAt: "Expected a local date and time like 2026-09-01T19:00.",
    });
  }

  const [, y, mo, d, h, mi] = match.map(Number) as unknown as number[];

  // Start from the naive UTC reading, then correct by the offset that zone was
  // actually at that moment. Two passes, because the offset itself can differ
  // either side of a DST boundary and the first guess may land on the wrong one.
  let utc = Date.UTC(y, mo - 1, d, h, mi);
  for (let pass = 0; pass < 2; pass += 1) {
    const offset = zoneOffsetMs(new Date(utc), timeZone);
    utc = Date.UTC(y, mo - 1, d, h, mi) - offset;
  }

  return new Date(utc);
}

/** How far ahead of UTC a zone was at a given instant, in milliseconds. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);

  const read = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");

  // `formatToParts` renders midnight as hour 24 in some engines.
  const hour = read("hour") % 24;

  const asUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    hour,
    read("minute"),
    read("second"),
  );

  return asUtc - at.getTime();
}
