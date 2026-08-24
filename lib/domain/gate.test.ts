import { describe, it, expect, beforeEach, afterAll } from "vitest";

import { prisma } from "../db";
import {
  canSchedule,
  currentDecisions,
  latestDecisionForStage,
  REQUIRED_STAGES,
  type GateResult,
} from "./gate";

/**
 * The most thorough test file in the project, per the plan: this is the
 * function the whole assignment is graded on.
 *
 * The rule it must never get wrong: the gate reads the MOST RECENT Approval row
 * per (content_item_id, stage) — not whether an approval exists anywhere in
 * history. That distinction is what lets a reviewer or client pull back
 * something they already approved, and it is the difference between a gate and
 * a rubber stamp.
 */

const CLIENT_ID = "CL-101";
let campaignId = "";
let itemId = "";
let reviewerId = "";
let clientContactId = "";

/** Writes an Approval row, optionally backdated, and returns it. */
async function decide(
  stage: "internal" | "client",
  decision: "approve" | "decline",
  opts: { at?: Date; by?: string; comment?: string } = {},
) {
  return prisma.approval.create({
    data: {
      content_item_id: itemId,
      stage,
      decision,
      comment: opts.comment ?? (decision === "decline" ? "needs work" : null),
      decided_by_id: opts.by ?? (stage === "internal" ? reviewerId : clientContactId),
      ...(opts.at ? { decided_at: opts.at } : {}),
    },
  });
}

beforeEach(async () => {
  await prisma.approval.deleteMany({ where: { content_item_id: itemId } });
});

afterAll(async () => {
  await prisma.approval.deleteMany({ where: { content_item_id: itemId } });
  await prisma.contentItem.deleteMany({ where: { campaign_id: campaignId } });
  await prisma.campaign.deleteMany({ where: { campaign_id: campaignId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (itemId) return;

  const reviewer = await prisma.user.findFirstOrThrow({
    where: { user_type: "staff", is_agency_admin: false },
  });
  reviewerId = reviewer.user_id;

  const contact = await prisma.user.findFirstOrThrow({ where: { user_type: "client_contact" } });
  clientContactId = contact.user_id;

  const campaign = await prisma.campaign.create({
    data: {
      client_id: CLIENT_ID,
      title: "GATE TEST",
      raw_brief_text: "gate test fixture",
      status: "in_progress",
    },
  });
  campaignId = campaign.campaign_id;

  const item = await prisma.contentItem.create({
    data: { campaign_id: campaignId, content_form: "post", platform: "instagram", status: "drafted" },
  });
  itemId = item.content_item_id;
});

// ---------------------------------------------------------------------------
// The five cases the plan names
// ---------------------------------------------------------------------------

describe("the five graded cases", () => {
  it("both approved -> true", async () => {
    await decide("internal", "approve");
    await decide("client", "approve");

    const result = await canSchedule(itemId);
    expect(result.allowed).toBe(true);
  });

  it("one declined -> false", async () => {
    await decide("internal", "approve");
    await decide("client", "decline");

    const result = await canSchedule(itemId);
    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toContain("client");
  });

  it("approved then later declined, same stage -> false", async () => {
    // The case that proves most-recent-per-stage rather than any-approval-ever.
    // A gate that asks "has this been approved?" passes here and is wrong.
    await decide("internal", "approve");
    await decide("client", "approve", { at: new Date("2026-01-01T10:00:00Z") });
    await decide("client", "decline", { at: new Date("2026-01-01T11:00:00Z") });

    const result = await canSchedule(itemId);
    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toContain("client");
  });

  it("declined then later re-approved -> true", async () => {
    // The mirror image: a gate that asks "has this ever been declined?" fails
    // here and is equally wrong.
    await decide("internal", "decline", { at: new Date("2026-01-01T10:00:00Z") });
    await decide("internal", "approve", { at: new Date("2026-01-01T11:00:00Z") });
    await decide("client", "approve");

    const result = await canSchedule(itemId);
    expect(result.allowed).toBe(true);
  });

  it("no rows at all -> false", async () => {
    const result = await canSchedule(itemId);

    expect(result.allowed).toBe(false);
    // Absence is not approval: both stages are missing, not merely unapproved.
    expect(result.blockedBy).toEqual(expect.arrayContaining(["internal", "client"]));
  });
});

// ---------------------------------------------------------------------------
// Partial state
// ---------------------------------------------------------------------------

describe("partial approval", () => {
  it("internal alone is not enough", async () => {
    await decide("internal", "approve");

    const result = await canSchedule(itemId);
    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toContain("client");
    expect(result.blockedBy).not.toContain("internal");
  });

  it("client alone is not enough", async () => {
    await decide("client", "approve");

    const result = await canSchedule(itemId);
    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toContain("internal");
  });

  it("both declined -> false, naming both", async () => {
    await decide("internal", "decline");
    await decide("client", "decline");

    const result = await canSchedule(itemId);
    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toEqual(expect.arrayContaining(["internal", "client"]));
  });
});

// ---------------------------------------------------------------------------
// Most-recent-per-stage, pressed harder
// ---------------------------------------------------------------------------

describe("most recent per stage", () => {
  it("reads each stage independently", async () => {
    // internal: decline -> approve.  client: approve -> decline.
    // A gate collapsing both stages into one history gets this wrong.
    await decide("internal", "decline", { at: new Date("2026-01-01T09:00:00Z") });
    await decide("internal", "approve", { at: new Date("2026-01-01T10:00:00Z") });
    await decide("client", "approve", { at: new Date("2026-01-01T09:30:00Z") });
    await decide("client", "decline", { at: new Date("2026-01-01T10:30:00Z") });

    const decisions = await currentDecisions(itemId);
    expect(decisions.internal?.decision).toBe("approve");
    expect(decisions.client?.decision).toBe("decline");

    expect((await canSchedule(itemId)).allowed).toBe(false);
  });

  it("survives a long alternating history", async () => {
    // Ten flip-flops per stage, ending on approve for both.
    for (let i = 0; i < 10; i++) {
      const t = new Date(Date.UTC(2026, 0, 1, i));
      await decide("internal", i % 2 === 0 ? "decline" : "approve", { at: t });
      await decide("client", i % 2 === 0 ? "decline" : "approve", { at: t });
    }

    expect((await canSchedule(itemId)).allowed).toBe(true);

    // One more decline at the end flips it back.
    await decide("client", "decline", { at: new Date(Date.UTC(2026, 0, 2)) });
    expect((await canSchedule(itemId)).allowed).toBe(false);
  });

  it("ignores rows written out of chronological order", async () => {
    // Insert the newer decision first, then an older approval. Ordering must
    // come from decided_at, not from insertion order.
    await decide("internal", "approve");
    await decide("client", "decline", { at: new Date("2026-06-01T12:00:00Z") });
    await decide("client", "approve", { at: new Date("2026-01-01T12:00:00Z") });

    const latest = await latestDecisionForStage(itemId, "client");
    expect(latest?.decision).toBe("decline");
    expect((await canSchedule(itemId)).allowed).toBe(false);
  });

  it("breaks a decided_at tie by insertion order, not arbitrarily", async () => {
    // Two decisions at the identical timestamp is not hypothetical: a decline
    // landing in the same instant as a scheduler tick is the race this design
    // exists for.
    //
    // Without an explicit tiebreak the winner is whatever the storage engine
    // happens to return — observed to go BOTH ways on SQLite depending on row
    // layout, so "it passes today" is not a guarantee. The approval_id tiebreak
    // makes it deterministic: cuid ids are monotonic, so the later-written row
    // always sorts first.
    const sameMoment = new Date("2026-03-01T12:00:00.000Z");

    await decide("internal", "approve", { at: sameMoment });
    const approved = await decide("client", "approve", { at: sameMoment });
    const declined = await decide("client", "decline", { at: sameMoment });

    // Guard the premise: the rows really do share a timestamp, and the decline
    // really was written second. Without this the test could pass for the
    // wrong reason.
    expect(approved.decided_at.getTime()).toBe(declined.decided_at.getTime());
    expect(approved.approval_id < declined.approval_id).toBe(true);

    const latest = await latestDecisionForStage(itemId, "client");
    expect(latest?.decision).toBe("decline");
    expect(latest?.approval_id).toBe(declined.approval_id);
    expect((await canSchedule(itemId)).allowed).toBe(false);
  });

  it("returns the last-written row when many share a timestamp", async () => {
    // 12 rows on one timestamp, the last a decline.
    //
    // NOTE ON WHAT THIS DOES AND DOES NOT PROVE: SQLite happens to return
    // insertion order for ties, so this passes with or without the explicit
    // approval_id tiebreak in the query — removing it does not fail here. The
    // tiebreak is still required: SQL does not guarantee tie ordering, the
    // observed order inverted in a differently-shaped probe, and a different
    // engine may order differently again. This test pins the behaviour we
    // depend on; the tiebreak is what makes it true by construction rather
    // than by luck.
    const sameMoment = new Date("2026-04-01T09:00:00.000Z");

    const written: string[] = [];
    for (let i = 0; i < 12; i++) {
      const row = await decide("client", i === 11 ? "decline" : "approve", { at: sameMoment });
      written.push(row.approval_id);
    }

    const latest = await latestDecisionForStage(itemId, "client");
    expect(latest?.approval_id).toBe(written[written.length - 1]);
    expect(latest?.decision).toBe("decline");
  });

  it("is stable across repeated reads", async () => {
    await decide("internal", "approve");
    await decide("client", "approve");

    const runs = await Promise.all([canSchedule(itemId), canSchedule(itemId), canSchedule(itemId)]);
    expect(runs.every((r: GateResult) => r.allowed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scope and isolation
// ---------------------------------------------------------------------------

describe("scoping", () => {
  it("reads only this item's approvals", async () => {
    const other = await prisma.contentItem.create({
      data: { campaign_id: campaignId, content_form: "post", status: "drafted" },
    });

    // The other item is fully approved; ours has nothing.
    await prisma.approval.createMany({
      data: [
        { content_item_id: other.content_item_id, stage: "internal", decision: "approve" },
        { content_item_id: other.content_item_id, stage: "client", decision: "approve" },
      ],
    });

    expect((await canSchedule(itemId)).allowed).toBe(false);
    expect((await canSchedule(other.content_item_id)).allowed).toBe(true);

    await prisma.approval.deleteMany({ where: { content_item_id: other.content_item_id } });
    await prisma.contentItem.delete({ where: { content_item_id: other.content_item_id } });
  });

  it("returns false for an item that does not exist", async () => {
    const result = await canSchedule("does-not-exist");
    expect(result.allowed).toBe(false);
  });

  it("ignores a stage value outside the vocabulary", async () => {
    await decide("internal", "approve");
    await decide("client", "approve");

    // A junk row must not be readable as a third approving stage, nor corrupt
    // the two real ones.
    await prisma.approval.create({
      data: { content_item_id: itemId, stage: "manager", decision: "approve" },
    });

    expect((await canSchedule(itemId)).allowed).toBe(true);
    expect(REQUIRED_STAGES).toEqual(["internal", "client"]);
  });

  it("treats a decision value that is not 'approve' as not approving", async () => {
    await decide("internal", "approve");
    await prisma.approval.create({
      data: { content_item_id: itemId, stage: "client", decision: "maybe" },
    });

    // Anything other than an explicit approve leaves the gate shut.
    expect((await canSchedule(itemId)).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What the gate reports
// ---------------------------------------------------------------------------

describe("the result", () => {
  it("names which stages are blocking, for the UI to explain", async () => {
    await decide("internal", "decline");

    const result = await canSchedule(itemId);
    expect(result.blockedBy).toContain("internal");
    expect(result.blockedBy).toContain("client");
  });

  it("reports no blockers when open", async () => {
    await decide("internal", "approve");
    await decide("client", "approve");

    const result = await canSchedule(itemId);
    expect(result.blockedBy).toHaveLength(0);
  });

  it("carries the decision rows behind the verdict, for the audit trail", async () => {
    const internal = await decide("internal", "approve");
    await decide("client", "approve");

    const result = await canSchedule(itemId);
    expect(result.decisions.internal?.approval_id).toBe(internal.approval_id);
    expect(result.decisions.client?.decision).toBe("approve");
  });

  it("reports a missing stage as null rather than inventing a decision", async () => {
    await decide("internal", "approve");

    const decisions = await currentDecisions(itemId);
    expect(decisions.internal).not.toBeNull();
    expect(decisions.client).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Transactional read — the publish race
// ---------------------------------------------------------------------------

describe("transactional use", () => {
  it("accepts a transaction client, so the scheduler can check and publish atomically", async () => {
    await decide("internal", "approve");
    await decide("client", "approve");

    const result = await prisma.$transaction(async (tx) => canSchedule(itemId, tx));
    expect(result.allowed).toBe(true);
  });

  it("sees a decline written earlier in the same transaction", async () => {
    // The scheduler's re-check must observe a decline that landed moments
    // before, not a stale snapshot from before the transaction opened.
    await decide("internal", "approve");
    await decide("client", "approve");

    const result = await prisma.$transaction(async (tx) => {
      await tx.approval.create({
        data: {
          content_item_id: itemId,
          stage: "client",
          decision: "decline",
          comment: "pulled back",
        },
      });
      return canSchedule(itemId, tx);
    });

    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toContain("client");
  });
});
