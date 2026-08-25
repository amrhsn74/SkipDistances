import { describe, it, expect } from "vitest";

import { prisma } from "../db";
import {
  DEFAULT_PLANNING_WEEKS,
  LOOKBACK_DAYS,
  formatCalendarForPrompt,
  planningWindow,
  resolveCalendar,
} from "./resolveCalendar";

/**
 * The wrapper's own decisions. The resolution and the shared-key collapse are
 * Phase 2's and tested there; what matters here is the window, and that a
 * dual-market client's differing dates survive into the prompt.
 */

const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

describe("planningWindow", () => {
  it("opens before the brief date and runs the default horizon", () => {
    const w = planningWindow({ from: "2026-02-01" });

    // Content is produced and approved before the day itself, so a window
    // starting at the brief date would exclude the occasion a brief filed a few
    // days late is plainly about.
    expect(iso(w.from)).toBe("2026-01-25");
    expect(iso(w.to)).toBe(
      iso(new Date(Date.UTC(2026, 1, 1) + DEFAULT_PLANNING_WEEKS * 7 * DAY_MS)),
    );
  });

  it("normalises to UTC midnight, so a boundary-day occasion is not dropped", () => {
    const w = planningWindow({ from: new Date("2026-02-01T16:45:00Z") });

    // An occasion is a whole day, not an instant. Comparing a midnight-stamped
    // occasion against a mid-afternoon date silently loses the boundary day.
    expect(w.from.getUTCHours()).toBe(0);
    expect(w.to.getUTCHours()).toBe(0);
    expect(iso(w.from)).toBe("2026-01-25");
  });

  it("accepts a custom horizon and lookback", () => {
    const w = planningWindow({ from: "2026-02-01", weeks: 2, lookbackDays: 0 });

    expect(iso(w.from)).toBe("2026-02-01");
    expect(iso(w.to)).toBe("2026-02-15");
  });

  it("falls back to today when the brief names no date", () => {
    const w = planningWindow();
    const span = Math.round((w.to.getTime() - w.from.getTime()) / DAY_MS);

    expect(span).toBe(DEFAULT_PLANNING_WEEKS * 7 + LOOKBACK_DAYS);
  });

  it("treats an unparseable date as no date rather than crashing", () => {
    // The extractor reports what it saw; a brief may well say "Q3" or nothing.
    const w = planningWindow({ from: "sometime in Q3" });

    expect(Number.isNaN(w.from.getTime())).toBe(false);
    expect(w.to.getTime()).toBeGreaterThan(w.from.getTime());
  });
});

describe("resolveCalendar against the seeded calendar", () => {
  /** Ramadan 2026: SA Feb 18, EG Feb 19 -- a real split observance. */
  const ramadanWindow = { from: new Date("2026-02-01"), to: new Date("2026-03-15") };

  it("splits shared from per-market occasions", async () => {
    const dual = await prisma.clientMarket.groupBy({
      by: ["client_id"],
      _count: { market_id: true },
      having: { market_id: { _count: { gt: 1 } } },
    });
    const dualClientId = dual[0].client_id;

    const cal = await resolveCalendar(dualClientId, ramadanWindow);

    expect(cal.occasions.length).toBeGreaterThan(0);
    // Every occasion lands in exactly one bucket.
    expect(cal.shared.length + cal.perMarket.length).toBe(cal.occasions.length);

    const ramadan = cal.occasions.find((o) => o.sharedKey === "ramadan");
    expect(ramadan).toBeDefined();
    // Egypt began Ramadan 2026 a day after Saudi Arabia; that difference is why
    // the dates are per-market at all.
    expect(ramadan!.sameDateAcrossMarkets).toBe(false);
    expect(cal.perMarket).toContain(ramadan);
  });

  it("gives a single-market client one date per occasion", async () => {
    const single = await prisma.client.findFirstOrThrow({
      where: { markets: { every: { market: { country_code: "EG" } } }, status: "active" },
      select: { client_id: true },
    });

    const cal = await resolveCalendar(single.client_id, ramadanWindow);

    for (const o of cal.occasions) {
      expect(o.dates).toHaveLength(1);
      // One market can never disagree with itself.
      expect(o.sameDateAcrossMarkets).toBe(true);
    }
    expect(cal.perMarket).toEqual([]);
  });

  it("returns nothing for a window with no occasions in it", async () => {
    const cal = await resolveCalendar("CL-101", {
      from: new Date("2026-06-02"),
      to: new Date("2026-06-09"),
    });

    expect(cal.occasions).toEqual([]);
    expect(cal.shared).toEqual([]);
    expect(cal.perMarket).toEqual([]);
  });
});

describe("formatCalendarForPrompt", () => {
  const base = { clientId: "CL-101", window: { from: new Date(), to: new Date() } };

  it("says so explicitly when nothing falls in the window", () => {
    const text = formatCalendarForPrompt({ ...base, occasions: [], shared: [], perMarket: [] });

    // An empty section reads as an omission, and a model that suspects an
    // omission fills it in.
    expect(text).toMatch(/no occasions/i);
    expect(text).toMatch(/do not invent/i);
  });

  it("spells out every market's own date for a split observance", () => {
    const ramadan = {
      key: "ramadan",
      name: "Ramadan",
      category: "religious",
      dateType: "hijri_based" as const,
      sharedKey: "ramadan",
      occasionIds: ["o1", "o2"],
      dates: [
        { marketId: "m-sa", date: new Date("2026-02-18") },
        { marketId: "m-eg", date: new Date("2026-02-19") },
      ],
      earliest: new Date("2026-02-18"),
      sameDateAcrossMarkets: false,
    };

    const text = formatCalendarForPrompt(
      { ...base, occasions: [ramadan], shared: [], perMarket: [ramadan] },
      { "m-sa": "Saudi Arabia", "m-eg": "Egypt" },
    );

    // Told only "Ramadan is in February", a model writes one caption for both
    // markets and schedules it a day wrong in one of them.
    expect(text).toContain("2026-02-18");
    expect(text).toContain("2026-02-19");
    expect(text).toContain("Saudi Arabia");
    expect(text).toContain("Egypt");
    expect(text).toMatch(/one item per market/i);
  });

  it("marks a same-date occasion as needing only one item", () => {
    const eid = {
      key: "eid",
      name: "Eid al-Fitr",
      category: "religious",
      dateType: "hijri_based" as const,
      sharedKey: "eid_al_fitr",
      occasionIds: ["o3", "o4"],
      dates: [
        { marketId: "m-sa", date: new Date("2026-03-20") },
        { marketId: "m-eg", date: new Date("2026-03-20") },
      ],
      earliest: new Date("2026-03-20"),
      sameDateAcrossMarkets: true,
    };

    const text = formatCalendarForPrompt({ ...base, occasions: [eid], shared: [eid], perMarket: [] });

    expect(text).toMatch(/one item covers both/i);
    expect(text).toContain("2026-03-20");
  });
});
