import { describe, it, expect, afterAll } from "vitest";

import { prisma } from "../db";
import { getGuidelinesForClient, resolveCitedClause } from "./retrievalScope";

/**
 * The isolation guarantee is graded, so these run against the full seeded
 * corpus -- 20 agency clauses and 8 brand guides across 150 clients -- rather
 * than a two-client fixture that could pass by accident.
 */

afterAll(() => prisma.$disconnect());

describe("getGuidelinesForClient", () => {
  it("returns the agency standards for every client", async () => {
    const scope = await getGuidelinesForClient("CL-101");

    expect(scope.agency).toHaveLength(20);
    expect(scope.agency.every((c) => c.source_type === "agency")).toBe(true);
    expect(scope.agency.map((c) => c.clause_code)).toContain("0.6");
    expect(scope.agency.map((c) => c.clause_code)).toContain("1.3");
  });

  it("returns the client's own brand clauses alongside them", async () => {
    const scope = await getGuidelinesForClient("CL-102"); // Cairo Roast

    expect(scope.brand).toHaveLength(5);
    expect(scope.brand.every((c) => c.clause_code.startsWith("CR."))).toBe(true);
    expect(scope.all).toHaveLength(25);
  });

  it("never returns another client's brand clauses", async () => {
    const cairoRoast = await getGuidelinesForClient("CL-102");
    const layla = await getGuidelinesForClient("CL-105");

    // CR.4 forbids discounts; LF.3 makes them core. Retrieving the wrong one is
    // exactly the failure the PRD's "same request lands differently" criterion
    // is about.
    expect(cairoRoast.brand.map((c) => c.clause_code)).toContain("CR.4");
    expect(cairoRoast.brand.map((c) => c.clause_code)).not.toContain("LF.3");

    expect(layla.brand.map((c) => c.clause_code)).toContain("LF.3");
    expect(layla.brand.map((c) => c.clause_code)).not.toContain("CR.4");
  });

  it("leaks no foreign brand clause for ANY seeded client, regardless of client count", async () => {
    // The plan asks for this specifically: assert across the whole roster, not
    // a pair, so the guarantee cannot pass by coincidence.
    const clients = await prisma.client.findMany({
      where: { NOT: { active_brand_guide_id: null } },
      select: { client_id: true, active_brand_guide_id: true },
    });
    expect(clients).toHaveLength(8);

    for (const c of clients) {
      const scope = await getGuidelinesForClient(c.client_id);

      // Every brand clause returned belongs to this client's own active guide.
      const foreign = await prisma.guidelineClause.findMany({
        where: {
          clause_id: { in: scope.brand.map((b) => b.clause_id) },
          NOT: { brand_guide_version_id: c.active_brand_guide_id },
        },
      });
      expect(foreign, `${c.client_id} received a clause from another guide`).toHaveLength(0);
    }
  });

  it("returns agency clauses alone for a client with no brand guide", async () => {
    const guideless = await prisma.client.findFirst({
      where: { active_brand_guide_id: null, status: "active" },
      select: { client_id: true },
    });
    expect(guideless).not.toBeNull();

    const scope = await getGuidelinesForClient(guideless!.client_id);

    // The majority case -- 142 of 150. It must not throw, and must not fall
    // back to some other client's rules.
    expect(scope.brandGuideVersionId).toBeNull();
    expect(scope.brand).toHaveLength(0);
    expect(scope.agency).toHaveLength(20);
    expect(scope.all).toHaveLength(20);
  });

  it("returns agency clauses for an unknown client rather than throwing", async () => {
    const scope = await getGuidelinesForClient("CL-DOES-NOT-EXIST");

    expect(scope.brand).toHaveLength(0);
    expect(scope.agency).toHaveLength(20);
  });

  it("ignores a superseded guide version, returning only the active one", async () => {
    const client = await prisma.client.findUnique({
      where: { client_id: "CL-101" },
      select: { active_brand_guide_id: true },
    });

    const superseded = await prisma.brandGuideVersion.create({
      data: { client_id: "CL-101", version_number: 99, status: "superseded" },
    });
    const staleClause = await prisma.guidelineClause.create({
      data: {
        source_type: "brand",
        brand_guide_version_id: superseded.brand_guide_version_id,
        clause_code: "NF.99",
        title: "Stale rule",
        text: "Should never be retrieved.",
      },
    });

    const scope = await getGuidelinesForClient("CL-101");

    expect(scope.brandGuideVersionId).toBe(client!.active_brand_guide_id);
    expect(scope.all.map((c) => c.clause_code)).not.toContain("NF.99");

    await prisma.guidelineClause.delete({ where: { clause_id: staleClause.clause_id } });
    await prisma.brandGuideVersion.delete({
      where: { brand_guide_version_id: superseded.brand_guide_version_id },
    });
  });
});

describe("resolveCitedClause", () => {
  it("resolves a clause the client can see", async () => {
    const agency = await resolveCitedClause("CL-102", "0.6");
    expect(agency?.clause_code).toBe("0.6");

    const brand = await resolveCitedClause("CL-102", "CR.4");
    expect(brand?.clause_code).toBe("CR.4");
  });

  it("returns null for a clause outside the client's scope", async () => {
    // LF.3 is real, but not Cairo Roast's -- a citation naming it must not
    // silently resolve.
    expect(await resolveCitedClause("CL-102", "LF.3")).toBeNull();
  });

  it("returns null for a clause that does not exist at all", async () => {
    expect(await resolveCitedClause("CL-102", "ZZ.99")).toBeNull();
  });
});
