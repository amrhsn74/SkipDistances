import { prisma, type Db } from "../db";
import { clientScopeWhere, type ScopeUser } from "./accessScope";

/**
 * What the calendar draws.
 *
 * Scoped through `clientScopeWhere` like every other list, for the same reason:
 * a calendar that took its scope from the request would show one client's
 * unpublished plan to another client's team by changing a parameter.
 *
 * Returns items that have a slot *and* items that are approved but unscheduled.
 * The second group is the point of the screen -- an approved item with no date
 * is work that will silently never go out, and a calendar that only drew booked
 * slots would be the one place that hid it.
 */

export type ScheduledItem = {
  content_item_id: string;
  campaign_id: string;
  campaign_title: string;
  client_id: string;
  client_name: string;
  content_form: string;
  platform: string | null;
  status: string;
  /** Null for an approved item that has no slot yet. */
  scheduled_date: Date | null;
  /** The zone this item's market observes, for rendering the local time. */
  market_timezone: string | null;
  market_name: string | null;
};

export type BoardRange = {
  /** Inclusive. */
  from: Date;
  /** Exclusive, so a month query is [1st, next 1st). */
  to: Date;
};

export type BoardOptions = {
  range?: BoardRange;
  clientId?: string | null;
};

/** Statuses worth a place on a calendar. */
const BOARD_STATUSES = [
  "client_approved",
  "scheduled",
  "publishing",
  "published",
  "publish_failed",
] as const;

/**
 * The calendar's rows.
 *
 * A month at a time by default. Unbounded would mean every published item ever
 * crossing the wire to draw one screen.
 */
export async function scheduleBoard(
  user: ScopeUser,
  options: BoardOptions = {},
  db: Db = prisma,
): Promise<ScheduledItem[]> {
  const scope = await clientScopeWhere(user, db);

  // The requested client is intersected with scope, never substituted for it.
  const clientFilter =
    options.clientId != null && options.clientId !== ""
      ? { AND: [scope, { client_id: options.clientId }] }
      : scope;

  const rows = await db.contentItem.findMany({
    where: {
      campaign: { is: clientFilter },
      status: { in: [...BOARD_STATUSES] },
      ...(options.range
        ? {
            // An unscheduled item has no date to compare, so it is matched by
            // the null branch rather than being filtered out of its own screen.
            OR: [
              { scheduled_date: { gte: options.range.from, lt: options.range.to } },
              { scheduled_date: null },
            ],
          }
        : {}),
    },
    orderBy: [{ scheduled_date: "asc" }, { created_at: "asc" }],
    take: 500,
    select: {
      content_item_id: true,
      campaign_id: true,
      content_form: true,
      platform: true,
      status: true,
      scheduled_date: true,
      campaign: { select: { title: true, client_id: true, client: { select: { name: true } } } },
      market: { select: { name: true, timezone: true } },
    },
  });

  return rows.map((r) => ({
    content_item_id: r.content_item_id,
    campaign_id: r.campaign_id,
    campaign_title: r.campaign.title,
    client_id: r.campaign.client_id,
    client_name: r.campaign.client.name,
    content_form: r.content_form,
    platform: r.platform,
    status: r.status,
    scheduled_date: r.scheduled_date,
    market_timezone: r.market?.timezone ?? null,
    market_name: r.market?.name ?? null,
  }));
}

/** The [start, end) of a calendar month, in UTC. */
export function monthRange(year: number, month1to12: number): BoardRange {
  return {
    from: new Date(Date.UTC(year, month1to12 - 1, 1)),
    to: new Date(Date.UTC(year, month1to12, 1)),
  };
}
