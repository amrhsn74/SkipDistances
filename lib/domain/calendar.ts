import { prisma, type Db } from "../db";

/**
 * Occasion resolution for a client's markets.
 *
 * The engine's `resolve_calendar` step: given every market a client operates in
 * and a planning window, return the occasions that fall inside it, with a real
 * Gregorian date attached.
 *
 * Two date types, resolved differently:
 *
 *   fixed_gregorian  month/day, projected onto each year the window spans
 *   hijri_based      looked up in OccasionDate, never computed
 *
 * Hijri dates are a seeded lookup rather than a calendar conversion (see
 * architecture §11). They also differ per market: Egypt did not sight the
 * crescent on 17 Feb 2026 and began Ramadan a day after Saudi Arabia. A single
 * shared date would be wrong for one of them.
 */

export type ResolvedOccasionDate = {
  marketId: string;
  /** The date this market observes it on, inside the requested window. */
  date: Date;
};

export type ResolvedOccasion = {
  /** Stable identity for the resolved entry -- the shared_key when the
   *  observance spans markets, otherwise the occasion's own id. */
  key: string;
  name: string;
  category: string;
  dateType: "fixed_gregorian" | "hijri_based";
  /** Set when this observance is shared across markets and was collapsed. */
  sharedKey: string | null;
  /** Every occasion row that folded into this entry. */
  occasionIds: string[];
  /**
   * Per-market dates. One entry for a single-market occasion; one per market
   * for a collapsed one -- and they can differ, which is the whole reason this
   * is a list rather than a single date.
   */
  dates: ResolvedOccasionDate[];
  /** Earliest date across markets. What a plan sorts on. */
  earliest: Date;
  /**
   * True when every market observes it on the same day. A dual-market plan can
   * produce one market-neutral item for these; a split observance needs an item
   * per market, since the scheduled dates differ.
   */
  sameDateAcrossMarkets: boolean;
};

export type DateRange = { from: Date; to: Date };

/**
 * Resolve occasions for one or more markets within a window.
 *
 * Occasions sharing a `shared_key` collapse into one entry carrying each
 * market's own date, so a dual-market client gets one Ramadan rather than two
 * near-duplicates. Occasions without a shared key stay separate even when they
 * happen to share a name -- "Back to School" is 1 September in Egypt and
 * 20 August in Saudi Arabia, and those are genuinely different moments to plan
 * around, not one observance.
 */
export async function resolveOccasions(
  marketIds: string[],
  range: DateRange,
  db: Db = prisma,
): Promise<ResolvedOccasion[]> {
  if (marketIds.length === 0) return [];
  if (range.to < range.from) return [];

  const occasions = await db.occasion.findMany({
    where: { market_id: { in: marketIds } },
    include: { dates: true },
  });

  // key -> entry under construction
  const byKey = new Map<string, ResolvedOccasion>();

  for (const occ of occasions) {
    const dates = datesInRange(occ, range);
    if (dates.length === 0) continue;

    // Collapse only on an explicit shared_key. Matching on name would merge
    // Egypt's and Saudi Arabia's Back to School, which fall three weeks apart.
    const key = occ.shared_key ?? occ.occasion_id;

    const existing = byKey.get(key);
    const marketDates: ResolvedOccasionDate[] = dates.map((date) => ({
      marketId: occ.market_id,
      date,
    }));

    if (existing) {
      existing.occasionIds.push(occ.occasion_id);
      existing.dates.push(...marketDates);
    } else {
      byKey.set(key, {
        key,
        name: occ.name,
        category: occ.category,
        dateType: occ.date_type === "hijri_based" ? "hijri_based" : "fixed_gregorian",
        sharedKey: occ.shared_key,
        occasionIds: [occ.occasion_id],
        dates: marketDates,
        earliest: dates[0],
        sameDateAcrossMarkets: true,
      });
    }
  }

  const resolved = Array.from(byKey.values());

  for (const entry of resolved) {
    entry.dates.sort((a, b) => a.date.getTime() - b.date.getTime());
    entry.earliest = entry.dates[0].date;

    const distinct = new Set(entry.dates.map((d) => d.date.getTime()));
    entry.sameDateAcrossMarkets = distinct.size === 1;
  }

  return resolved.sort((a, b) => a.earliest.getTime() - b.earliest.getTime());
}

type OccasionRow = {
  occasion_id: string;
  market_id: string;
  name: string;
  category: string;
  date_type: string;
  month: number | null;
  day: number | null;
  shared_key: string | null;
  dates: Array<{ year: number; gregorian_date: Date }>;
};

/** Every date this occasion falls on inside the window, ascending. */
function datesInRange(occ: OccasionRow, range: DateRange): Date[] {
  const found =
    occ.date_type === "hijri_based"
      ? occ.dates.map((d) => d.gregorian_date)
      : fixedGregorianDates(occ, range);

  return found
    .filter((d) => d >= range.from && d <= range.to)
    .sort((a, b) => a.getTime() - b.getTime());
}

/**
 * A fixed occasion recurs every year, so it is projected onto each year the
 * window spans -- a window crossing a new year must still surface January
 * occasions from the later year.
 */
function fixedGregorianDates(occ: OccasionRow, range: DateRange): Date[] {
  const month = occ.month;
  const day = occ.day;
  if (month == null || day == null) return [];

  const out: Date[] = [];
  for (let year = range.from.getUTCFullYear(); year <= range.to.getUTCFullYear(); year++) {
    const date: Date = new Date(Date.UTC(year, month - 1, day));
    // Guard a date the calendar does not have, e.g. 29 February in a common
    // year: Date rolls it into March, which would be the wrong occasion.
    if (date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      out.push(date);
    }
  }
  return out;
}

/**
 * The markets a client operates in. The engine's calendar step starts here --
 * `resolve_calendar` is scoped to the client, never to a market passed in from
 * a brief.
 */
export async function getMarketIdsForClient(
  clientId: string,
  db: Db = prisma,
): Promise<string[]> {
  const rows = await db.clientMarket.findMany({
    where: { client_id: clientId },
    select: { market_id: true },
  });
  return rows.map((r: { market_id: string }) => r.market_id);
}

/** Convenience: resolve for a client rather than a market list. */
export async function resolveOccasionsForClient(
  clientId: string,
  range: DateRange,
  db: Db = prisma,
): Promise<ResolvedOccasion[]> {
  return resolveOccasions(await getMarketIdsForClient(clientId, db), range, db);
}
