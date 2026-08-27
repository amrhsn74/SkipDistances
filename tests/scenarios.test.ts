import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/db";
import { visibleClientIds } from "@/domain/accessScope";
import { recordDecision } from "@/domain/approvals";
import { resolveOccasions } from "@/domain/calendar";
import { canSchedule, latestDecisionForStage } from "@/domain/gate";
import { SingleClientApproverError } from "@/domain/clientContactInvariant";
import { assignRole } from "@/domain/roleAssignment";
import { ACCEPTED_TYPES } from "@/domain/referenceTypes";

/**
 * `P12.2` — the scenarios worth proving on purpose.
 *
 * Each `describe` below is one line from the Phase 12 checklist, and each is a
 * decision made somewhere across this design that would be expensive to get
 * wrong and invisible if it silently regressed. Most have unit coverage in their
 * own module already; this file is the place they are asserted *as scenarios* --
 * end to end, against the real database, in the terms the PRD argues in.
 *
 * The duplication is deliberate and worth naming. `gate.test.ts` proves the gate
 * reads most-recent-per-stage against a table of rows; the test here drives the
 * same rule through `recordDecision` and asks whether an item can actually be
 * scheduled. A unit test that passes while the feature is broken is exactly what
 * a scenario suite is for.
 *
 * Two of the nine checklist items are **not** re-implemented here, because they
 * already have dedicated suites that assert more than a copy would:
 *
 *   - Publish race condition -> `tests/publishRace.test.ts` (P9.4). It records
 *     every call to Instagram, so it can assert the publish was never *made*
 *     rather than merely that the status ended up right.
 *   - PostRequest -> Campaign never bypasses the gate -> the "a request carries
 *     no authority" block in `tests/api/postRequests.route.test.ts`, which
 *     drives it through the real route with bypass wording in the comment.
 *
 * Pointing at them beats duplicating them: a second copy of a scenario is a
 * second thing to keep in step, and the weaker copy is the one that rots.
 */

const CLIENT = "CL-101";
/** A second client, for the isolation scenarios. Never the same as `CLIENT`. */
const OTHER_CLIENT = "CL-102";

const REVIEWER = "TEST-SC-REVIEWER";
const CONTACT = "TEST-SC-CONTACT";
const CREATOR = "TEST-SC-CREATOR";
const OTHER_CONTACT = "TEST-SC-CONTACT-2";
/** `assignRole` refuses anyone who is not an active agency admin. */
const ADMIN = "TEST-SC-ADMIN";
const USERS = [REVIEWER, CONTACT, CREATOR, OTHER_CONTACT, ADMIN];

const campaignIds: string[] = [];

/** A drafted item sitting at internal review, which is where decisions start. */
async function seedItem(status = "pending_internal_review") {
  const campaign = await prisma.campaign.create({
    data: { client_id: CLIENT, title: "P12.2 scenario", raw_brief_text: "scenario" },
  });
  campaignIds.push(campaign.campaign_id);

  const item = await prisma.contentItem.create({
    data: {
      campaign_id: campaign.campaign_id,
      content_form: "post",
      platform: "instagram",
      content_body: "Scenario body.",
      status,
    },
  });

  return item.content_item_id;
}

beforeEach(async () => {
  await cleanup();

  for (const id of USERS) {
    await prisma.user.upsert({
      where: { user_id: id },
      update: { status: "active", is_agency_admin: id === ADMIN },
      create: {
        user_id: id,
        name: id,
        email: `${id.toLowerCase()}@skipstudio.test`,
        user_type: id === CONTACT || id === OTHER_CONTACT ? "client_contact" : "staff",
        is_agency_admin: id === ADMIN,
      },
    });
  }
});

afterAll(async () => {
  await cleanup();
  await prisma.clientAssignment.deleteMany({ where: { user_id: { in: USERS } } });
  await prisma.user.deleteMany({ where: { user_id: { in: USERS } } });
});

async function cleanup() {
  await prisma.clientAssignment.deleteMany({ where: { user_id: { in: USERS } } });

  if (campaignIds.length === 0) return;
  const items = await prisma.contentItem.findMany({
    where: { campaign_id: { in: campaignIds } },
    select: { content_item_id: true },
  });
  const itemIds = items.map((i) => i.content_item_id);

  await prisma.referenceAttachment.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.contentItemCitation.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.approval.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.auditLog.deleteMany({ where: { entity_id: { in: [...itemIds, ...campaignIds] } } });
  await prisma.contentItem.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  await prisma.campaign.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  campaignIds.length = 0;
}

/* ── Gate reads most-recent-per-stage ─────────────────────────────────── */

describe("the gate reads the most recent decision per stage", () => {
  it("stays blocked after approve → decline, even though an approval exists", async () => {
    const itemId = await seedItem();

    await recordDecision(itemId, {
      stage: "internal",
      decision: "approve",
      decidedById: REVIEWER,
    });

    // The row above is still in the table. If the gate asked "is there an
    // approval?" rather than "what is the latest?", this would open.
    await recordDecision(itemId, {
      stage: "internal",
      decision: "decline",
      comment: "Second thoughts — the claim needs a source.",
      decidedById: REVIEWER,
    });

    const gate = await canSchedule(itemId);
    expect(gate.allowed).toBe(false);

    const latest = await latestDecisionForStage(itemId, "internal");
    expect(latest?.decision).toBe("decline");

    // Both rows survive: the trail is append-only, which is what lets an admin
    // see that somebody changed their mind rather than just the end state.
    const rows = await prisma.approval.count({
      where: { content_item_id: itemId, stage: "internal" },
    });
    expect(rows).toBe(2);
  });

  it("needs both stages current, not merely both once present", async () => {
    const itemId = await seedItem();

    await recordDecision(itemId, {
      stage: "internal",
      decision: "approve",
      decidedById: REVIEWER,
    });
    await recordDecision(itemId, {
      stage: "client",
      decision: "approve",
      decidedById: CONTACT,
    });

    expect((await canSchedule(itemId)).allowed).toBe(true);

    // One stage withdraws. The other stage's approval is untouched and still
    // the latest of its own stage -- and the gate must still close.
    await recordDecision(itemId, {
      stage: "client",
      decision: "decline",
      comment: "Holding this one back.",
      decidedById: CONTACT,
    });

    expect((await canSchedule(itemId)).allowed).toBe(false);
  });
});

/* ── Symmetric late revoke ────────────────────────────────────────────── */

describe("late revoke is symmetric", () => {
  it("lets either side withdraw after both approved, with the same effect", async () => {
    for (const revoker of ["internal", "client"] as const) {
      const itemId = await seedItem();

      await recordDecision(itemId, {
        stage: "internal",
        decision: "approve",
        decidedById: REVIEWER,
      });
      await recordDecision(itemId, {
        stage: "client",
        decision: "approve",
        decidedById: CONTACT,
      });
      expect((await canSchedule(itemId)).allowed).toBe(true);

      await recordDecision(itemId, {
        stage: revoker,
        decision: "decline",
        comment: "Withdrawing.",
        decidedById: revoker === "internal" ? REVIEWER : CONTACT,
      });

      // The assertion that matters: neither party is privileged. Whoever
      // withdraws, the item stops being schedulable.
      expect((await canSchedule(itemId)).allowed).toBe(false);
    }
  });

  it("refuses a decline once the post is published, for both stages alike", async () => {
    for (const stage of ["internal", "client"] as const) {
      const itemId = await seedItem("published");

      // Past `published` the only remaining lever is the staff take-down, not a
      // withdrawal -- a post already on Instagram cannot be un-approved.
      await expect(
        recordDecision(itemId, {
          stage,
          decision: "decline",
          comment: "Too late.",
          decidedById: stage === "internal" ? REVIEWER : CONTACT,
        }),
      ).rejects.toThrow();
    }
  });
});

/* ── Single client-contact invariant ──────────────────────────────────── */

describe("a client contact holds exactly one assignment", () => {
  it("refuses a second client for the same contact", async () => {
    await assignRole({
      clientId: CLIENT,
      userId: CONTACT,
      role: "client_approver",
      byAdminId: ADMIN,
    });

    // The invariant is what makes "their client" a well-defined thing to
    // resolve from a session, so a second assignment cannot be allowed to
    // quietly win.
    await expect(
      assignRole({
        clientId: OTHER_CLIENT,
        userId: CONTACT,
        role: "client_approver",
        byAdminId: ADMIN,
      }),
      // The specific error, not merely "something threw": the invariant has its
      // own type precisely so a caller can tell this refusal apart from a
      // malformed role or an unknown client.
    ).rejects.toBeInstanceOf(SingleClientApproverError);

    const held = await prisma.clientAssignment.count({ where: { user_id: CONTACT } });
    expect(held).toBe(1);
  });

  it("resolves exactly one client id for a contact's session", async () => {
    await assignRole({
      clientId: CLIENT,
      userId: CONTACT,
      role: "client_approver",
      byAdminId: ADMIN,
    });

    const visible = await visibleClientIds({
      user_id: CONTACT,
      user_type: "client_contact",
      is_agency_admin: false,
    });

    expect(visible).toEqual([CLIENT]);
  });
});

/* ── Reference attachment scope ───────────────────────────────────────── */

describe("reference attachments accept only what the PRD admits", () => {
  it("accepts image, PDF and document types, and nothing else", () => {
    const types = new Set(Object.values(ACCEPTED_TYPES).map((t) => t.fileType));
    expect([...types].sort()).toEqual(["doc", "image", "pdf"]);

    // PRD §4 puts video out of scope, and the allowlist is closed rather than a
    // denylist -- so a format nobody considered fails shut.
    expect(Object.keys(ACCEPTED_TYPES)).not.toContain("video/mp4");
    expect(Object.keys(ACCEPTED_TYPES)).not.toContain("application/zip");
  });
});

/* ── Cross-client isolation, at the query layer ───────────────────────── */

describe("cross-client isolation holds at the query layer", () => {
  it("never shows one contact another client's id", async () => {
    await assignRole({
      clientId: CLIENT,
      userId: CONTACT,
      role: "client_approver",
      byAdminId: ADMIN,
    });
    await assignRole({
      clientId: OTHER_CLIENT,
      userId: OTHER_CONTACT,
      role: "client_approver",
      byAdminId: ADMIN,
    });

    const mine = await visibleClientIds({
      user_id: CONTACT,
      user_type: "client_contact",
      is_agency_admin: false,
    });
    const theirs = await visibleClientIds({
      user_id: OTHER_CONTACT,
      user_type: "client_contact",
      is_agency_admin: false,
    });

    expect(mine).toEqual([CLIENT]);
    expect(theirs).toEqual([OTHER_CLIENT]);
    // The scopes are disjoint. Asserted rather than implied: this is the
    // property the whole access layer exists to hold.
    expect(mine.filter((id) => theirs.includes(id))).toEqual([]);
  });

  it("scopes a creator to their assignments and no further", async () => {
    await assignRole({
      clientId: CLIENT,
      userId: CREATOR,
      role: "content_creator",
      byAdminId: ADMIN,
    });

    const visible = await visibleClientIds({
      user_id: CREATOR,
      user_type: "staff",
      is_agency_admin: false,
    });

    expect(visible).toContain(CLIENT);
    expect(visible).not.toContain(OTHER_CLIENT);
  });
});

/* ── Hijri occasion dates ─────────────────────────────────────────────── */

const YEAR_2026 = { from: new Date("2026-01-01"), to: new Date("2026-12-31") };

describe("Hijri occasions resolve per market", () => {
  it("gives Ramadan a different date in Egypt and Saudi Arabia", async () => {
    const markets = await prisma.market.findMany({
      where: { country_code: { in: ["EG", "SA"] } },
      select: { market_id: true, country_code: true },
    });
    expect(markets).toHaveLength(2);

    const byId = new Map(markets.map((m) => [m.market_id, m.country_code]));

    // Both markets at once, so Ramadan collapses into one entry carrying each
    // market's own date -- which is exactly the shape under test.
    const resolved = await resolveOccasions(
      markets.map((m) => m.market_id),
      YEAR_2026,
    );

    const ramadan = resolved.find((o) => o.name.toLowerCase().includes("ramadan"));
    expect(ramadan, "Ramadan not resolved for 2026").toBeDefined();
    expect(ramadan!.dateType).toBe("hijri_based");

    const dates = new Map(
      ramadan!.dates.map((d) => [byId.get(d.marketId)!, d.date.toISOString().slice(0, 10)]),
    );

    // Moon sighting differs between the two, which is the whole reason a date
    // is per market rather than a single column on the occasion.
    expect(dates.get("EG")).toBe("2026-02-19");
    expect(dates.get("SA")).toBe("2026-02-18");
    expect(ramadan!.sameDateAcrossMarkets).toBe(false);
  });

  it("keeps a national day out of the other country's calendar", async () => {
    const egypt = await prisma.market.findFirstOrThrow({
      where: { country_code: "EG" },
      select: { market_id: true },
    });

    const resolved = await resolveOccasions([egypt.market_id], YEAR_2026);
    const names = resolved.map((o) => o.name.toLowerCase());

    expect(names.some((n) => n.includes("saudi national"))).toBe(false);
  });
});

/* ── Dual-market fan-out ──────────────────────────────────────────────── */

describe("dual-market fan-out", () => {
  it("collapses a shared observance into one entry, not two near-duplicates", async () => {
    // One of the hero clients operating in both countries.
    const dual = await prisma.client.findFirstOrThrow({
      where: { markets: { some: { market: { country_code: "SA" } } } },
      select: {
        client_id: true,
        markets: { select: { market_id: true } },
      },
    });

    const marketIds = dual.markets.map((m) => m.market_id);
    expect(marketIds.length).toBeGreaterThan(1);

    const resolved = await resolveOccasions(marketIds, YEAR_2026);

    const ramadan = resolved.filter((o) => o.name.toLowerCase().includes("ramadan"));
    // One entry, carrying both markets' dates -- not one entry per market. A
    // dual-market client gets one Ramadan plan, scheduled twice.
    expect(ramadan).toHaveLength(1);
    expect(ramadan[0].dates.length).toBe(2);
  });

  it("keeps each national day to its own market", async () => {
    const dual = await prisma.client.findFirstOrThrow({
      where: { markets: { some: { market: { country_code: "SA" } } } },
      select: { markets: { select: { market_id: true } } },
    });

    const resolved = await resolveOccasions(
      dual.markets.map((m) => m.market_id),
      YEAR_2026,
    );

    const national = resolved.filter((o) => o.category === "national");
    expect(national.length).toBeGreaterThan(1);

    // A national day is observed by one country, so it never collapses across
    // markets: each stays a separate entry against a single market.
    for (const day of national) {
      expect(day.dates).toHaveLength(1);
    }
  });

  it("never leaks the other market's occasions to a single-market client", async () => {
    const egyptOnly = await prisma.client.findFirstOrThrow({
      where: { markets: { every: { market: { country_code: "EG" } }, some: {} } },
      select: { markets: { select: { market_id: true } } },
    });

    const resolved = await resolveOccasions(
      egyptOnly.markets.map((m) => m.market_id),
      YEAR_2026,
    );

    expect(resolved.some((o) => o.name.toLowerCase().includes("saudi national"))).toBe(false);
  });
});
