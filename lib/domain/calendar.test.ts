import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { prisma } from "../db";
import {
  resolveOccasions,
  resolveOccasionsForClient,
  getMarketIdsForClient,
  type DateRange,
} from "./calendar";

/**
 * Runs against the seeded calendar: Egypt and Saudi Arabia, with Ramadan and the
 * two Eids sharing a key across both markets but resolving a day apart, and
 * national days belonging to one market only.
 */

let EG = "";
let SA = "";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const range = (from: string, to: string): DateRange => ({
  from: new Date(`${from}T00:00:00.000Z`),
  to: new Date(`${to}T00:00:00.000Z`),
});

const YEAR_2026 = range("2026-01-01", "2026-12-31");

beforeAll(async () => {
  EG = (await prisma.market.findUniqueOrThrow({ where: { country_code: "EG" } })).market_id;
  SA = (await prisma.market.findUniqueOrThrow({ where: { country_code: "SA" } })).market_id;
});

afterAll(() => prisma.$disconnect());

describe("hijri resolution", () => {
  it("resolves Ramadan 2026 from the seeded table, per market", async () => {
    const eg = await resolveOccasions([EG], YEAR_2026);
    const sa = await resolveOccasions([SA], YEAR_2026);

    const egRamadan = eg.find((o) => o.name === "Ramadan")!;
    const saRamadan = sa.find((o) => o.name === "Ramadan")!;

    // The dates a naive Hijri-to-Gregorian conversion gets wrong.
    expect(iso(egRamadan.earliest)).toBe("2026-02-19");
    expect(iso(saRamadan.earliest)).toBe("2026-02-18");
  });

  it("resolves both Eids 2026 per market", async () => {
    const eg = await resolveOccasions([EG], YEAR_2026);
    const sa = await resolveOccasions([SA], YEAR_2026);

    const byName = (list: typeof eg, name: string) => iso(list.find((o) => o.name === name)!.earliest);

    expect(byName(eg, "Eid al-Fitr")).toBe("2026-03-20");
    expect(byName(sa, "Eid al-Fitr")).toBe("2026-03-19");
    expect(byName(eg, "Eid al-Adha")).toBe("2026-05-27");
    expect(byName(sa, "Eid al-Adha")).toBe("2026-05-26");
  });

  it("resolves 2027 too, so a window near a year end still finds them", async () => {
    const resolved = await resolveOccasions([SA], range("2027-01-01", "2027-12-31"));
    expect(iso(resolved.find((o) => o.name === "Ramadan")!.earliest)).toBe("2027-02-07");
  });

  it("returns no hijri occasion for a year with no seeded date", async () => {
    // 2028 is not seeded. It must come back empty rather than guessing --
    // the table needs reseeding each year, and silently inventing a date is
    // the failure mode a computed conversion would have.
    const resolved = await resolveOccasions([EG, SA], range("2028-01-01", "2028-12-31"));
    expect(resolved.filter((o) => o.dateType === "hijri_based")).toHaveLength(0);
  });
});

describe("collapsing shared occasions", () => {
  it("a dual-market client gets ONE Ramadan entry, not two", async () => {
    const resolved = await resolveOccasions([EG, SA], YEAR_2026);
    const ramadan = resolved.filter((o) => o.name === "Ramadan");

    expect(ramadan).toHaveLength(1);
    expect(ramadan[0].occasionIds).toHaveLength(2);
  });

  it("the collapsed entry carries BOTH markets' dates", async () => {
    const resolved = await resolveOccasions([EG, SA], YEAR_2026);
    const ramadan = resolved.find((o) => o.name === "Ramadan")!;

    expect(ramadan.dates).toHaveLength(2);

    const egDate = ramadan.dates.find((d) => d.marketId === EG)!;
    const saDate = ramadan.dates.find((d) => d.marketId === SA)!;

    expect(iso(egDate.date)).toBe("2026-02-19");
    expect(iso(saDate.date)).toBe("2026-02-18");
  });

  it("flags Ramadan as split across markets, so the plan schedules per market", async () => {
    const resolved = await resolveOccasions([EG, SA], YEAR_2026);
    const ramadan = resolved.find((o) => o.name === "Ramadan")!;

    // Egypt and Saudi Arabia observe it a day apart, so one shared
    // scheduled_date would be wrong for one of them.
    expect(ramadan.sameDateAcrossMarkets).toBe(false);
  });

  it("flags Black Friday as same-date, so one market-neutral item covers it", async () => {
    const resolved = await resolveOccasions([EG, SA], YEAR_2026);
    const bf = resolved.find((o) => o.name === "Black Friday")!;

    expect(bf.dates).toHaveLength(2);
    expect(bf.sameDateAcrossMarkets).toBe(true);
  });

  it("does NOT collapse same-named occasions that lack a shared key", async () => {
    // "Back to School" is 1 September in Egypt and 20 August in Saudi Arabia.
    // Collapsing on name would merge two genuinely different planning moments.
    const resolved = await resolveOccasions([EG, SA], YEAR_2026);
    const bts = resolved.filter((o) => o.name === "Back to School");

    expect(bts).toHaveLength(2);
    expect(bts.map((o) => iso(o.earliest)).sort()).toEqual(["2026-08-20", "2026-09-01"]);
  });

  it("a single-market client sees one date on a shared occasion", async () => {
    const resolved = await resolveOccasions([EG], YEAR_2026);
    const ramadan = resolved.find((o) => o.name === "Ramadan")!;

    expect(ramadan.dates).toHaveLength(1);
    expect(ramadan.sameDateAcrossMarkets).toBe(true);
  });
});

describe("market scoping", () => {
  it("Egypt's Revolution Day never appears for a Saudi-only client", async () => {
    const resolved = await resolveOccasions([SA], YEAR_2026);
    const names = resolved.map((o) => o.name);

    expect(names).not.toContain("Revolution Day");
    expect(names).not.toContain("Sinai Liberation Day");
    expect(names).not.toContain("Coptic Christmas");
    expect(names).toContain("Saudi National Day");
  });

  it("Saudi National Day never appears for an Egypt-only client", async () => {
    const resolved = await resolveOccasions([EG], YEAR_2026);
    const names = resolved.map((o) => o.name);

    expect(names).not.toContain("Saudi National Day");
    expect(names).not.toContain("Saudi Founding Day");
    expect(names).toContain("Revolution Day");
  });

  it("a dual-market client sees both markets' national days, uncollapsed", async () => {
    const resolved = await resolveOccasions([EG, SA], YEAR_2026);
    const names = resolved.map((o) => o.name);

    expect(names).toContain("Revolution Day");
    expect(names).toContain("Saudi National Day");
  });

  it("returns nothing for no markets", async () => {
    expect(await resolveOccasions([], YEAR_2026)).toHaveLength(0);
  });
});

describe("the planning window", () => {
  it("excludes occasions outside it", async () => {
    // Ramadan 2026 is in February; a March-only window must not include it.
    const resolved = await resolveOccasions([EG], range("2026-03-01", "2026-03-31"));
    const names = resolved.map((o) => o.name);

    expect(names).not.toContain("Ramadan");
    expect(names).toContain("Eid al-Fitr"); // 20 March
  });

  it("includes an occasion on the window's exact boundaries", async () => {
    const onFrom = await resolveOccasions([EG], range("2026-02-19", "2026-02-28"));
    expect(onFrom.map((o) => o.name)).toContain("Ramadan");

    const onTo = await resolveOccasions([EG], range("2026-02-01", "2026-02-19"));
    expect(onTo.map((o) => o.name)).toContain("Ramadan");
  });

  it("projects a fixed occasion across every year the window spans", async () => {
    // A window crossing the new year must surface January occasions from the
    // later year -- Coptic Christmas is 7 January.
    const resolved = await resolveOccasions([EG], range("2026-12-01", "2027-01-31"));
    const christmas = resolved.find((o) => o.name === "Coptic Christmas")!;

    expect(christmas).toBeDefined();
    expect(iso(christmas.earliest)).toBe("2027-01-07");
  });

  it("returns results in date order", async () => {
    const resolved = await resolveOccasions([EG, SA], YEAR_2026);
    const times = resolved.map((o) => o.earliest.getTime());

    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("returns nothing for an inverted range", async () => {
    expect(await resolveOccasions([EG], range("2026-12-31", "2026-01-01"))).toHaveLength(0);
  });
});

describe("resolveOccasionsForClient", () => {
  it("scopes to the client's own markets -- CL-101 is Egypt only", async () => {
    expect(await getMarketIdsForClient("CL-101")).toEqual([EG]);

    const resolved = await resolveOccasionsForClient("CL-101", YEAR_2026);
    const names = resolved.map((o) => o.name);

    expect(names).toContain("Revolution Day");
    expect(names).not.toContain("Saudi National Day");
  });

  it("covers both markets for a dual-market client -- CL-104", async () => {
    expect((await getMarketIdsForClient("CL-104")).sort()).toEqual([EG, SA].sort());

    const resolved = await resolveOccasionsForClient("CL-104", YEAR_2026);
    const names = resolved.map((o) => o.name);

    expect(names).toContain("Revolution Day");
    expect(names).toContain("Saudi National Day");
    expect(resolved.filter((o) => o.name === "Ramadan")).toHaveLength(1);
  });

  it("returns nothing for a client with no markets", async () => {
    expect(await resolveOccasionsForClient("CL-DOES-NOT-EXIST", YEAR_2026)).toHaveLength(0);
  });
});
