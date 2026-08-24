import { describe, it, expect, afterAll } from "vitest";

import { prisma } from "../db";
import { isOk } from "./decision";
import { resolveClient, CLAUSE_UNKNOWN_OR_INACTIVE } from "./clientResolution";

/**
 * Runs against the seeded roster rather than invented rows: CL-101 (NileFit,
 * active), CL-109 (Pyramide Motors, inactive, no account manager) and CL-103
 * (MedCare, sensitive sector) are all real records from clients.json, so these
 * tests fail if the seed drifts.
 */

afterAll(() => prisma.$disconnect());

describe("resolveClient", () => {
  it("resolves a known active client", async () => {
    const result = await resolveClient("CL-101");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.client_id).toBe("CL-101");
    expect(result.value.name).toBe("NileFit");
    expect(result.value.status).toBe("active");
  });

  it("flags a known but inactive client, citing Clause 0.6", async () => {
    const result = await resolveClient("CL-109");

    expect(result.decision).toBe("FLAG");
    if (result.decision !== "FLAG") return;

    expect(result.clauseCode).toBe(CLAUSE_UNKNOWN_OR_INACTIVE);
    expect(result.flagType).toBe("inactive_client");
    expect(result.reason).toMatch(/inactive/);
  });

  it("flags an unknown client id, citing Clause 0.6", async () => {
    const result = await resolveClient("CL-999");

    expect(result.decision).toBe("FLAG");
    if (result.decision !== "FLAG") return;

    expect(result.clauseCode).toBe(CLAUSE_UNKNOWN_OR_INACTIVE);
    expect(result.flagType).toBe("unknown_client");
  });

  it("distinguishes unknown from inactive -- different situations for the human", async () => {
    const unknown = await resolveClient("CL-999");
    const inactive = await resolveClient("CL-109");

    expect(unknown.decision).toBe("FLAG");
    expect(inactive.decision).toBe("FLAG");
    if (unknown.decision !== "FLAG" || inactive.decision !== "FLAG") return;

    expect(unknown.flagType).not.toBe(inactive.flagType);
  });

  it("flags a missing client id without throwing -- B-026 names no roster client", async () => {
    for (const value of [null, undefined, ""]) {
      const result = await resolveClient(value);
      expect(result.decision).toBe("FLAG");
      if (result.decision !== "FLAG") continue;
      expect(result.flagType).toBe("unknown_client");
      expect(result.clauseCode).toBe(CLAUSE_UNKNOWN_OR_INACTIVE);
    }
  });

  it("returns every market the client operates in", async () => {
    const single = await resolveClient("CL-101");
    const dual = await resolveClient("CL-104");

    expect(isOk(single) && single.value.marketIds).toHaveLength(1);
    expect(isOk(dual) && dual.value.marketIds).toHaveLength(2);
  });

  it("decodes channels back into an array", async () => {
    const result = await resolveClient("CL-101");

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value.channels).toEqual(["instagram", "tiktok", "facebook"]);
  });

  it("carries sensitive_sector through for Clause 1.8", async () => {
    const medcare = await resolveClient("CL-103");
    const nilefit = await resolveClient("CL-101");

    expect(isOk(medcare) && medcare.value.sensitive_sector).toBe(true);
    expect(isOk(nilefit) && nilefit.value.sensitive_sector).toBe(false);
  });

  it("resolves a client with no brand guide -- the majority of the roster", async () => {
    const guideless = await prisma.client.findFirst({
      where: { active_brand_guide_id: null, status: "active" },
    });
    expect(guideless).not.toBeNull();

    const result = await resolveClient(guideless!.client_id);

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.active_brand_guide_id).toBeNull();
  });

  it("resolves a client with no account manager without failing", async () => {
    // CL-109 is inactive, so build the same shape on an active client to prove
    // a null account manager is not itself a resolution failure.
    const created = await prisma.client.create({
      data: {
        client_id: "TEST-NO-AM",
        name: "No AM",
        industry: "retail",
        status: "active",
        channels: JSON.stringify(["instagram"]),
        account_manager_id: null,
      },
    });

    const result = await resolveClient(created.client_id);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value.account_manager_id).toBeNull();

    await prisma.client.delete({ where: { client_id: created.client_id } });
  });
});
