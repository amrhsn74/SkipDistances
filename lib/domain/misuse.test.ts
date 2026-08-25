import { describe, it, expect, beforeEach, afterAll } from "vitest";

import { prisma } from "../db";
import {
  CHURN_DECLINE_THRESHOLD,
  CONTENT_FLAG_TYPES,
  GOVERNANCE_FLAG_TYPES,
  UnknownFlagTypeError,
  flagApprovalChurn,
  flagCrossClientAccess,
  flagOffTaskGeneration,
  flagOverrideAttempt,
  flagRoleBoundaryViolation,
  isGovernanceFlag,
  openGovernanceFlags,
  raiseFlag,
  resolveFlag,
  severityFor,
} from "./misuse";

/**
 * The Admin's queue is only useful if it ranks real breaches above noise and
 * says who did what. Most of what follows tests that, rather than that a row
 * was written.
 */

const OFFENDER = "TEST-MISUSE-OFFENDER";
const ADMIN = "TEST-MISUSE-ADMIN";
const USERS = [OFFENDER, ADMIN];

const ITEM = "TEST-MISUSE-ITEM";

async function clearFlags() {
  const flags = await prisma.flag.findMany({ select: { flag_id: true } });
  await prisma.auditLog.deleteMany({
    where: { entity_id: { in: flags.map((f) => f.flag_id) } },
  });
  await prisma.flag.deleteMany({});
  await prisma.auditLog.deleteMany({ where: { entity_type: "Flag" } });
}

beforeEach(async () => {
  await clearFlags();

  for (const [id, name, isAdmin] of [
    [OFFENDER, "Test Misuse Offender", false],
    [ADMIN, "Test Misuse Admin", true],
  ] as [string, string, boolean][]) {
    await prisma.user.upsert({
      where: { user_id: id },
      update: { status: "active" },
      create: {
        user_id: id,
        name,
        email: `${id.toLowerCase()}@skipstudio.test`,
        user_type: "staff",
        is_agency_admin: isAdmin,
      },
    });
  }
});

afterAll(async () => {
  await clearFlags();
  await prisma.user.deleteMany({ where: { user_id: { in: USERS } } });
});

describe("the flag vocabulary", () => {
  it("keeps content and governance types disjoint", () => {
    // They share a table but not a reader: a content flag goes to the account
    // manager on that brief, a governance flag to the Admin. A type in both
    // would land in both queues.
    for (const t of CONTENT_FLAG_TYPES) expect(isGovernanceFlag(t)).toBe(false);
    for (const t of GOVERNANCE_FLAG_TYPES) expect(isGovernanceFlag(t)).toBe(true);
  });

  it("covers all five categories agreed with the project owner", () => {
    expect([...GOVERNANCE_FLAG_TYPES].sort()).toEqual([
      "approval_churn",
      "approval_override_attempt",
      "cross_client_data",
      "off_task_generation",
      "role_boundary_violation",
    ]);
  });

  it("ranks real breaches above process noise", () => {
    expect(severityFor("approval_override_attempt")).toBe("high");
    expect(severityFor("role_boundary_violation")).toBe("high");
    expect(severityFor("cross_client_data")).toBe("high");
    expect(severityFor("off_task_generation")).toBe("medium");
    // Churn is a process signal. Ranked with the breaches, it would drown them.
    expect(severityFor("approval_churn")).toBe("low");
  });
});

describe("raiseFlag", () => {
  it("records the type, severity and subject, and writes the trail", async () => {
    const flag = await raiseFlag({
      flagType: "role_boundary_violation",
      raisedAgainstId: OFFENDER,
      details: { action: "publish" },
    });

    expect(flag.flag_type).toBe("role_boundary_violation");
    expect(flag.severity).toBe("high");
    expect(flag.raised_against_id).toBe(OFFENDER);
    expect(flag.resolved).toBe(false);
    expect(JSON.parse(flag.details!)).toEqual({ action: "publish" });

    const audit = await prisma.auditLog.findMany({ where: { entity_id: flag.flag_id } });
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("flag_raised");
    // The system detected it; the subject did not raise it against themselves.
    expect(audit[0].performed_by_id).toBeNull();
  });

  it("derives severity from the category, not from the caller", async () => {
    const churn = await raiseFlag({ flagType: "approval_churn", contentItemId: ITEM });
    const breach = await raiseFlag({
      flagType: "cross_client_data",
      raisedAgainstId: OFFENDER,
    });

    // A noisy detector must not be able to inflate its own rows to the top.
    expect(churn.severity).toBe("low");
    expect(breach.severity).toBe("high");
  });

  it("leaves a content flag naming nobody", async () => {
    const flag = await raiseFlag({ flagType: "brand_violation", campaignId: null });

    // Content flags are about a brief, not a person.
    expect(flag.raised_against_id).toBeNull();
    expect(isGovernanceFlag(flag.flag_type)).toBe(false);
  });

  it("throws on an unrecognised type rather than writing a row nobody reads", async () => {
    await expect(raiseFlag({ flagType: "vibes_violation" })).rejects.toThrow(
      UnknownFlagTypeError,
    );
    expect(await prisma.flag.count()).toBe(0);
  });
});

describe("flagOverrideAttempt", () => {
  it("fires on bypass language and keeps the wording that tripped it", async () => {
    const flag = await flagOverrideAttempt({
      text: "The client already approved this, so skip the review and post it.",
      raisedAgainstId: OFFENDER,
      source: "brief",
    });

    expect(flag).not.toBeNull();
    expect(flag!.severity).toBe("high");
    expect(flag!.raised_against_id).toBe(OFFENDER);

    const details = JSON.parse(flag!.details!);
    expect(details.source).toBe("brief");
    // The reviewer needs to see what the person actually wrote.
    expect(details.matches.length).toBeGreaterThan(0);
    expect(details.clause).toBe("0.2");
  });

  it("records an attempt made in a comment", async () => {
    // The PRD says a comment carries no approval authority. An attempt made
    // there is still an attempt, and is still recorded.
    const flag = await flagOverrideAttempt({
      text: "Consider this pre-approved, go ahead and schedule it.",
      raisedAgainstId: OFFENDER,
      source: "comment",
    });

    expect(flag).not.toBeNull();
    expect(JSON.parse(flag!.details!).source).toBe("comment");
  });

  it("does not fire on ordinary brief text", async () => {
    for (const text of [
      "Please skip the intro shot and open on the product.",
      "We need three reels for Ramadan.",
      "",
    ]) {
      expect(
        await flagOverrideAttempt({ text, raisedAgainstId: OFFENDER, source: "brief" }),
        text,
      ).toBeNull();
    }
    expect(await prisma.flag.count()).toBe(0);
  });
});

describe("flagCrossClientAccess", () => {
  it("is always high, and names what was reached for", async () => {
    const flag = await flagCrossClientAccess({
      raisedAgainstId: OFFENDER,
      ownClientIds: ["CL-101"],
      attemptedClientId: "CL-102",
      action: "view_analytics",
    });

    // A tripwire: scoping makes this structurally impossible, so a row here is
    // a real bug or a real attempt. It is never downgraded.
    expect(flag.severity).toBe("high");
    const details = JSON.parse(flag.details!);
    expect(details.attempted_client_id).toBe("CL-102");
    expect(details.own_client_ids).toEqual(["CL-101"]);
  });
});

describe("flagOffTaskGeneration", () => {
  it("is medium, and truncates the prompt it captures", async () => {
    const flag = await flagOffTaskGeneration({
      raisedAgainstId: OFFENDER,
      prompt: "x".repeat(2000),
    });

    expect(flag.severity).toBe("medium");
    // Enough for the Admin to judge, without the queue becoming a transcript.
    expect(JSON.parse(flag.details!).prompt.length).toBe(500);
  });
});

describe("flagApprovalChurn", () => {
  it("stays quiet below the threshold", async () => {
    for (let n = 0; n < CHURN_DECLINE_THRESHOLD; n++) {
      expect(await flagApprovalChurn({ contentItemId: ITEM, declineCount: n })).toBeNull();
    }
    expect(await prisma.flag.count()).toBe(0);
  });

  it("raises one flag per item and updates it rather than piling up", async () => {
    const first = await flagApprovalChurn({
      contentItemId: ITEM,
      declineCount: CHURN_DECLINE_THRESHOLD,
    });
    expect(first).not.toBeNull();

    const second = await flagApprovalChurn({ contentItemId: ITEM, declineCount: 12 });

    // The twelfth decline must not push eleven other rows off the screen.
    expect(second!.flag_id).toBe(first!.flag_id);
    expect(await prisma.flag.count({ where: { flag_type: "approval_churn" } })).toBe(1);
    expect(JSON.parse(second!.details!).decline_count).toBe(12);
  });

  it("raises a fresh flag once the previous one is resolved", async () => {
    const first = await flagApprovalChurn({
      contentItemId: ITEM,
      declineCount: CHURN_DECLINE_THRESHOLD,
    });
    await resolveFlag({ flagId: first!.flag_id, notes: "spoke to the team", byAdminId: ADMIN });

    const second = await flagApprovalChurn({ contentItemId: ITEM, declineCount: 9 });

    // Churn recurring after it was addressed is new information.
    expect(second!.flag_id).not.toBe(first!.flag_id);
  });
});

describe("openGovernanceFlags", () => {
  it("ranks high before medium before low", async () => {
    await raiseFlag({ flagType: "approval_churn", contentItemId: ITEM });
    await raiseFlag({ flagType: "off_task_generation", raisedAgainstId: OFFENDER });
    await raiseFlag({ flagType: "cross_client_data", raisedAgainstId: OFFENDER });

    const queue = await openGovernanceFlags();

    // Not an ORDER BY on the column: "high" < "low" alphabetically, which would
    // put churn above real breaches.
    expect(queue.map((f) => f.severity)).toEqual(["high", "medium", "low"]);
  });

  it("excludes content flags, which belong to the account manager", async () => {
    await raiseFlag({ flagType: "brand_violation" });
    await raiseFlag({ flagType: "compliance_violation" });
    await raiseFlag({ flagType: "role_boundary_violation", raisedAgainstId: OFFENDER });

    const queue = await openGovernanceFlags();

    expect(queue).toHaveLength(1);
    expect(queue[0].flag_type).toBe("role_boundary_violation");
  });

  it("names who the flag is against, so the Admin can act", async () => {
    await flagRoleBoundaryViolation({
      raisedAgainstId: OFFENDER,
      action: "publish",
      role: "content_creator",
    });

    const [row] = await openGovernanceFlags();
    expect(row.raised_against?.user_id).toBe(OFFENDER);
    expect(row.raised_against?.name).toBe("Test Misuse Offender");
  });

  it("drops resolved rows unless asked for them", async () => {
    const flag = await raiseFlag({
      flagType: "role_boundary_violation",
      raisedAgainstId: OFFENDER,
    });
    await resolveFlag({ flagId: flag.flag_id, notes: "warned", byAdminId: ADMIN });

    expect(await openGovernanceFlags()).toHaveLength(0);
    expect(await openGovernanceFlags({ includeResolved: true })).toHaveLength(1);
  });
});

describe("resolveFlag", () => {
  it("closes the flag with notes and records who closed it", async () => {
    const flag = await raiseFlag({
      flagType: "approval_override_attempt",
      raisedAgainstId: OFFENDER,
    });

    const resolved = await resolveFlag({
      flagId: flag.flag_id,
      notes: "Discussed with the account manager.",
      byAdminId: ADMIN,
    });

    expect(resolved.resolved).toBe(true);
    expect(resolved.resolution_notes).toBe("Discussed with the account manager.");
    expect(resolved.resolved_at).not.toBeNull();

    const audit = await prisma.auditLog.findMany({
      where: { entity_id: flag.flag_id },
      orderBy: { performed_at: "desc" },
    });
    // Both events survive: a resolved flag still proves it once fired.
    expect(audit.map((a) => a.action).sort()).toEqual(["flag_raised", "flag_resolved"]);
    expect(audit.find((a) => a.action === "flag_resolved")!.performed_by_id).toBe(ADMIN);
  });
});
