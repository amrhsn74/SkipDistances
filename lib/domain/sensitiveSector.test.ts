import { describe, it, expect, afterAll } from "vitest";

import { prisma } from "../db";
import {
  isSensitiveSector,
  normalizeIndustry,
  requiresComplianceReview,
  CLAUSE_SENSITIVE_SECTOR,
} from "./sensitiveSector";

afterAll(() => prisma.$disconnect());

describe("normalizeIndustry", () => {
  it("lowercases and collapses separators, so near-duplicates match alike", () => {
    expect(normalizeIndustry("Food & Beverage")).toBe("food beverage");
    expect(normalizeIndustry("f&b")).toBe("f b");
    expect(normalizeIndustry("  Financial   Services ")).toBe("financial services");
  });

  it("handles null and undefined", () => {
    expect(normalizeIndustry(null)).toBe("");
    expect(normalizeIndustry(undefined)).toBe("");
  });
});

describe("isSensitiveSector", () => {
  it("is true for the three sectors Clause 1.8 names", () => {
    expect(isSensitiveSector("healthcare")).toBe(true);
    expect(isSensitiveSector("financial services")).toBe(true);
    expect(isSensitiveSector("government")).toBe(true);
  });

  it("is false for ordinary sectors", () => {
    for (const i of ["fitness", "retail", "logistics", "events", "education", "travel"]) {
      expect(isSensitiveSector(i)).toBe(false);
    }
  });

  it("matches wordings the roster does not literally use", () => {
    // Free text: a new client could be entered any of these ways.
    for (const i of ["Private Medical Clinic", "Retail Banking", "Health & Wellness", "Insurance"]) {
      expect(isSensitiveSector(i)).toBe(true);
    }
  });

  it("does not treat 'hospitality' as healthcare", () => {
    // StayEasy Hotels (CL-108) is hospitality. A substring match on "hospital"
    // marks a hotel chain as a healthcare client and forces mandatory
    // compliance review on every campaign it ever runs.
    expect(isSensitiveSector("hospitality")).toBe(false);
    expect(isSensitiveSector("hospital")).toBe(true);
  });

  it("does not over-match other words that merely contain a sensitive term", () => {
    expect(isSensitiveSector("banking")).toBe(true);
    expect(isSensitiveSector("riverbank tours")).toBe(false);
    expect(isSensitiveSector("healthy snacks")).toBe(false);
  });

  it("tolerates plurals the roster might use", () => {
    expect(isSensitiveSector("clinics")).toBe(true);
    expect(isSensitiveSector("banks")).toBe(true);
  });

  it("is false for empty or missing industry", () => {
    for (const i of ["", "   ", null, undefined]) {
      expect(isSensitiveSector(i)).toBe(false);
    }
  });

  it("requiresComplianceReview is the same rule", () => {
    expect(requiresComplianceReview("healthcare")).toBe(isSensitiveSector("healthcare"));
    expect(requiresComplianceReview("fitness")).toBe(isSensitiveSector("fitness"));
  });

  it("cites Clause 1.8", () => {
    expect(CLAUSE_SENSITIVE_SECTOR).toBe("1.8");
  });
});

describe("against the seeded roster", () => {
  it("agrees with the stored column for every one of the 150 clients", async () => {
    // The column is denormalized, so a drift between the two would mean a client
    // marked sensitive at seed time and read as ordinary at draft time.
    const clients = await prisma.client.findMany({
      select: { client_id: true, industry: true, sensitive_sector: true },
    });
    expect(clients).toHaveLength(150);

    for (const c of clients) {
      expect(
        c.sensitive_sector,
        `${c.client_id} (${c.industry}) stored ${c.sensitive_sector}`,
      ).toBe(isSensitiveSector(c.industry));
    }
  });

  it("flags MedCare and NileBank, the two sensitive hero clients", async () => {
    const sensitive = await prisma.client.findMany({
      where: { sensitive_sector: true },
      select: { client_id: true },
    });
    const ids = sensitive.map((c: { client_id: string }) => c.client_id);

    expect(ids).toContain("CL-103"); // MedCare Clinics, healthcare
    expect(ids).toContain("CL-104"); // NileBank, financial services
  });

  it("does not flag the non-sensitive hero clients", async () => {
    const clients = await prisma.client.findMany({
      where: { client_id: { in: ["CL-101", "CL-102", "CL-105", "CL-106", "CL-107", "CL-108"] } },
      select: { client_id: true, sensitive_sector: true },
    });

    for (const c of clients) {
      expect(c.sensitive_sector, `${c.client_id}`).toBe(false);
    }
  });

  it("classifies every distinct industry in the roster without an unhandled value", async () => {
    const rows = await prisma.client.findMany({ select: { industry: true } });
    const industries = Array.from(new Set(rows.map((r: { industry: string }) => r.industry)));

    // 18 distinct free-text values -- the reason this matches on substrings
    // rather than equality.
    expect(industries.length).toBeGreaterThanOrEqual(18);
    for (const i of industries) {
      expect(typeof isSensitiveSector(i)).toBe("boolean");
    }
  });
});
