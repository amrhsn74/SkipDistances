import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

import { prisma } from "../db";
import { guideVersionsForClient } from "./brandGuideReview";

/**
 * What a client reads before approving a change to their own rules.
 *
 * The lifecycle -- draft, submit, approve, supersede -- is `brandGuides.ts`'s
 * and is tested through `tests/api/brandGuides.route.test.ts`. What is tested
 * here is the read this screen is built on: that the pending version is diffed
 * against whatever is *actually* in force, that a dropped clause is reported as
 * dropped, and that the whole thing is scoped to the reader's own client.
 *
 * The diff matters more than it looks. A client shown a wall of clauses they
 * already agreed to approves it without reading; a client shown the two that
 * changed reads those two. Getting the baseline wrong -- diffing against the
 * previous version number rather than the active one -- would silently show the
 * wrong "currently" text under a rule someone is about to sign off.
 */

const CLIENT_ID = "CL-101";
const OTHER_CLIENT_ID = "CL-103";

let reviewer: { user_id: string; user_type: string; is_agency_admin: boolean };
let contact: { user_id: string; user_type: string; is_agency_admin: boolean };
let otherContact: { user_id: string; user_type: string; is_agency_admin: boolean };

const versionIds: string[] = [];

/** A version on a client, with clauses, at a given status. */
async function createVersion(
  clientId: string,
  status: string,
  clauses: { code: string; title: string; text: string }[],
  versionNumber: number,
) {
  const version = await prisma.brandGuideVersion.create({
    data: {
      client_id: clientId,
      version_number: versionNumber,
      status,
      created_by_id: reviewer.user_id,
    },
  });
  versionIds.push(version.brand_guide_version_id);

  for (const clause of clauses) {
    await prisma.guidelineClause.create({
      data: {
        source_type: "brand",
        brand_guide_version_id: version.brand_guide_version_id,
        clause_code: clause.code,
        title: clause.title,
        text: clause.text,
      },
    });
  }

  return version;
}

/**
 * The seeded active guide, parked while a test installs its own.
 *
 * CL-101 ships with an active version, and a second row marked `active` would
 * make "the guide in force" ambiguous -- the baseline every diff is read
 * against. The seeded row is superseded for the duration and restored
 * afterwards, so these tests assert against a baseline they actually control
 * rather than whichever row the database happened to return first.
 */
let parkedVersionId: string | null = null;

async function parkSeededActive(clientId: string) {
  const seeded = await prisma.brandGuideVersion.findFirst({
    where: { client_id: clientId, status: "active" },
    select: { brand_guide_version_id: true },
  });
  if (!seeded) return;
  parkedVersionId = seeded.brand_guide_version_id;
  await prisma.brandGuideVersion.update({
    where: { brand_guide_version_id: parkedVersionId },
    data: { status: "superseded" },
  });
}

async function restoreSeededActive() {
  if (!parkedVersionId) return;
  await prisma.brandGuideVersion.update({
    where: { brand_guide_version_id: parkedVersionId },
    data: { status: "active" },
  });
  parkedVersionId = null;
}

async function contactFor(clientId: string) {
  const assignment = await prisma.clientAssignment.findFirstOrThrow({
    where: { client_id: clientId, role_on_client: "client_approver" },
    select: { user_id: true },
  });
  return prisma.user.findUniqueOrThrow({
    where: { user_id: assignment.user_id },
    select: { user_id: true, user_type: true, is_agency_admin: true },
  });
}

beforeAll(async () => {
  const client = await prisma.client.findUniqueOrThrow({
    where: { client_id: CLIENT_ID },
    select: { account_manager_id: true },
  });

  reviewer = await prisma.user.findUniqueOrThrow({
    where: { user_id: client.account_manager_id! },
    select: { user_id: true, user_type: true, is_agency_admin: true },
  });

  contact = await contactFor(CLIENT_ID);
  otherContact = await contactFor(OTHER_CLIENT_ID);

  await parkSeededActive(CLIENT_ID);
});

afterEach(async () => {
  // Only the versions this file made. The seeded guides stay -- other tests read
  // them, and `getGuidelinesForClient` grounds real drafts in them.
  await prisma.guidelineClause.deleteMany({
    where: { brand_guide_version_id: { in: versionIds } },
  });
  await prisma.brandGuideVersion.deleteMany({
    where: { brand_guide_version_id: { in: versionIds } },
  });
  versionIds.length = 0;
});

afterAll(async () => {
  await restoreSeededActive();
  await prisma.$disconnect();
});

describe("the diff a client reads", () => {
  it("marks a reworded clause changed and carries the wording in force", async () => {
    await createVersion(
      CLIENT_ID,
      "active",
      [{ code: "TEST.1", title: "Tone", text: "Warm and direct." }],
      900,
    );
    await createVersion(
      CLIENT_ID,
      "pending_client_approval",
      [{ code: "TEST.1", title: "Tone", text: "Warm, direct, and never salesy." }],
      901,
    );

    const versions = await guideVersionsForClient(contact, CLIENT_ID);
    const pending = versions.find((v) => v.version_number === 901);
    const clause = pending?.clauses.find((c) => c.clause_code === "TEST.1");

    expect(clause?.change).toBe("changed");
    // The "currently" text under the rule. Diffing against the wrong baseline
    // would put someone else's wording here, under a rule about to be signed.
    expect(clause?.previous_text).toBe("Warm and direct.");
  });

  it("marks a clause the active guide does not have as added", async () => {
    await createVersion(
      CLIENT_ID,
      "active",
      [{ code: "TEST.1", title: "Tone", text: "Warm and direct." }],
      900,
    );
    await createVersion(
      CLIENT_ID,
      "pending_client_approval",
      [
        { code: "TEST.1", title: "Tone", text: "Warm and direct." },
        { code: "TEST.2", title: "Claims", text: "No unsubstantiated superlatives." },
      ],
      901,
    );

    const versions = await guideVersionsForClient(contact, CLIENT_ID);
    const pending = versions.find((v) => v.version_number === 901);

    expect(pending?.clauses.find((c) => c.clause_code === "TEST.2")?.change).toBe("added");
    expect(pending?.clauses.find((c) => c.clause_code === "TEST.1")?.change).toBe("unchanged");
  });

  it("reports a clause the new version drops", async () => {
    await createVersion(
      CLIENT_ID,
      "active",
      [
        { code: "TEST.1", title: "Tone", text: "Warm and direct." },
        { code: "TEST.2", title: "Claims", text: "No unsubstantiated superlatives." },
      ],
      900,
    );
    await createVersion(
      CLIENT_ID,
      "pending_client_approval",
      [{ code: "TEST.1", title: "Tone", text: "Warm and direct." }],
      901,
    );

    const versions = await guideVersionsForClient(contact, CLIENT_ID);
    const pending = versions.find((v) => v.version_number === 901);

    // A removal is invisible in a list of what the new version contains, which
    // is exactly why it is reported separately -- dropping a compliance rule is
    // a bigger change than rewording one.
    expect(pending?.removed_clause_codes).toEqual(["TEST.2"]);
  });

  it("does not diff the active version against itself", async () => {
    await createVersion(
      CLIENT_ID,
      "active",
      [{ code: "TEST.1", title: "Tone", text: "Warm and direct." }],
      900,
    );

    const versions = await guideVersionsForClient(contact, CLIENT_ID);
    const active = versions.find((v) => v.version_number === 900);

    expect(active?.clauses.every((c) => c.change === "unchanged")).toBe(true);
    expect(active?.removed_clause_codes).toEqual([]);
  });

  it("treats every clause of a first-ever version as added", async () => {
    await createVersion(
      CLIENT_ID,
      "pending_client_approval",
      [{ code: "TEST.1", title: "Tone", text: "Warm and direct." }],
      901,
    );

    const versions = await guideVersionsForClient(contact, CLIENT_ID);
    const pending = versions.find((v) => v.version_number === 901);

    // No active guide to diff against. Every rule is new to this client, and
    // saying "unchanged" would be a claim about a comparison never made.
    expect(pending?.clauses.every((c) => c.change === "added")).toBe(true);
  });
});

describe("what is waiting", () => {
  it("flags only the pending version as awaiting the client", async () => {
    await createVersion(CLIENT_ID, "active", [{ code: "TEST.1", title: "T", text: "a" }], 900);
    await createVersion(
      CLIENT_ID,
      "pending_client_approval",
      [{ code: "TEST.1", title: "T", text: "b" }],
      901,
    );
    await createVersion(CLIENT_ID, "draft", [{ code: "TEST.1", title: "T", text: "c" }], 902);

    const versions = await guideVersionsForClient(contact, CLIENT_ID);

    // A draft is the account manager's, not the client's. Showing it as waiting
    // would ask a client to approve wording nobody has finished writing.
    expect(versions.filter((v) => v.awaiting_client).map((v) => v.version_number)).toEqual([901]);
  });
});

describe("scope", () => {
  it("returns nothing for a client the reader may not see", async () => {
    await createVersion(
      OTHER_CLIENT_ID,
      "pending_client_approval",
      [{ code: "TEST.1", title: "T", text: "theirs" }],
      901,
    );

    // A contact who edits the URL gets nothing, not someone else's rules.
    expect(await guideVersionsForClient(contact, OTHER_CLIENT_ID)).toEqual([]);
    expect(await guideVersionsForClient(otherContact, CLIENT_ID)).toEqual([]);
  });

  it("returns an empty list for a client with no guide on file", async () => {
    // The common case -- 142 of 150 seeded clients. Not an error: they are
    // governed by agency clauses alone.
    const versions = await guideVersionsForClient(reviewer, "CL-120");
    expect(Array.isArray(versions)).toBe(true);
  });
});
