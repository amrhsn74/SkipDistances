import { prisma, type Db } from "../db";
import {
  type DateRange,
  type ResolvedOccasion,
  resolveOccasionsForClient,
} from "../domain/calendar";

/**
 * Step 4: which occasions fall in this campaign's planning window.
 *
 * A thin wrapper. The resolution itself — including the shared-key collapse that
 * gives a dual-market client one Ramadan rather than two — is Phase 2's, and is
 * tested there. What lives here is the part that is about *campaigns* rather
 * than about calendars: turning a brief's date into a window, and shaping the
 * result for a prompt.
 *
 * The window matters more than it looks. Too narrow and a plan misses the
 * occasion it was commissioned for; too wide and the model is handed a year of
 * holidays and writes about whichever one it finds most interesting.
 */

/**
 * How far ahead a plan looks by default.
 *
 * Eight weeks: long enough that a campaign briefed today can be built around an
 * occasion far enough out to produce for, short enough that the model is not
 * choosing between a dozen unrelated holidays. A brief naming its own window
 * overrides this.
 */
export const DEFAULT_PLANNING_WEEKS = 8;

/**
 * Lead time before the window opens.
 *
 * Content for an occasion is produced and approved *before* the day itself, so a
 * window starting at the brief date would exclude the occasion a brief filed a
 * few days late is plainly about.
 */
export const LOOKBACK_DAYS = 7;

const DAY_MS = 86_400_000;

export type PlanningWindowInput = {
  /** The brief's date, or today when it names none. */
  from?: Date | string | null;
  weeks?: number;
  lookbackDays?: number;
};

/**
 * Build the window a plan is drafted against.
 *
 * Dates are normalised to UTC midnight. An occasion is a whole day, not an
 * instant, and comparing a midnight-stamped occasion against a mid-afternoon
 * `new Date()` silently drops anything falling on the boundary day.
 */
export function planningWindow(input: PlanningWindowInput = {}): DateRange {
  const {
    from,
    weeks = DEFAULT_PLANNING_WEEKS,
    lookbackDays = LOOKBACK_DAYS,
  } = input;

  const base = from ? new Date(from) : new Date();
  if (Number.isNaN(base.getTime())) {
    // An unparseable brief date means "no date", not a crash -- the extractor
    // reports what it saw, and a brief may well say "Q3" or nothing at all.
    return planningWindow({ ...input, from: null });
  }

  const start = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate());

  return {
    from: new Date(start - lookbackDays * DAY_MS),
    to: new Date(start + weeks * 7 * DAY_MS),
  };
}

export type CampaignCalendar = {
  clientId: string;
  window: DateRange;
  occasions: ResolvedOccasion[];
  /**
   * Occasions every one of the client's markets observes on the same day.
   * These can carry a market-neutral item, produced once.
   */
  shared: ResolvedOccasion[];
  /**
   * Occasions whose date differs by market, or that only one market observes.
   * Each needs its own item, scheduled against that market's own date — which
   * is exactly why `ContentItem.market_id` exists.
   */
  perMarket: ResolvedOccasion[];
};

/**
 * Resolve the calendar for one campaign.
 *
 * The split into `shared` and `perMarket` is the engine's, not the calendar's:
 * Phase 2 reports the facts (`sameDateAcrossMarkets`), and this decides what
 * that means for how many items get drafted.
 */
export async function resolveCalendar(
  clientId: string,
  window: DateRange,
  db: Db = prisma,
): Promise<CampaignCalendar> {
  const occasions = await resolveOccasionsForClient(clientId, window, db);

  return {
    clientId,
    window,
    occasions,
    shared: occasions.filter((o) => o.sameDateAcrossMarkets),
    perMarket: occasions.filter((o) => !o.sameDateAcrossMarkets),
  };
}

/**
 * Render the calendar for a prompt.
 *
 * Every per-market date is spelled out rather than summarised. A model told only
 * "Ramadan is in February" will write one caption for both markets and schedule
 * it a day wrong in one of them — Egypt began Ramadan 2026 a day after Saudi
 * Arabia, and that difference is the entire reason the dates are per-market.
 */
export function formatCalendarForPrompt(
  calendar: CampaignCalendar,
  marketNames: Record<string, string> = {},
): string {
  if (calendar.occasions.length === 0) {
    // Said explicitly. An empty section reads as an omission, and a model that
    // suspects an omission fills it in.
    return "No occasions fall within this planning window. Do not invent one.";
  }

  const lines = calendar.occasions.map((o) => {
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    if (o.sameDateAcrossMarkets) {
      return `- ${o.name} (${o.category}) — ${iso(o.earliest)}, same date in every market. One item covers both.`;
    }

    const perMarket = o.dates
      .map((d) => `${marketNames[d.marketId] ?? d.marketId}: ${iso(d.date)}`)
      .join("; ");

    return `- ${o.name} (${o.category}) — dates differ by market (${perMarket}). Needs one item per market, each tagged to that market.`;
  });

  return lines.join("\n");
}
