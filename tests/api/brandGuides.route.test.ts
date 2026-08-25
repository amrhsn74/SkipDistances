import { describe, it, expect, afterEach, vi } from "vitest";

import { prisma } from "@/db";
import { SESSION_COOKIE } from "@/api/request";
import { createSession } from "@/domain/session";
import { getGuidelinesForClient } from "@/domain/retrievalScope";

/**
 * The HTTP shell over a client's brand guide.
 *
 * The load-bearing claim this endpoint has to make good on, from PRD §6: a guide
 * is **editable in-app, and gated behind client approval before a new version
 * takes effect**. So the tests here are mostly about the gap between those two
 * halves -- that an account manager creating and submitting a version changes
 * nothing about what the engine grounds in, and that the client's approval is
 * the single moment it does.
 *
 * The check that matters most is the one driven through
 * `getGuidelinesForClient`: not "the status column says active" but "the
 * retrieval scope the engine actually reads now returns the new clauses". A
 * version could be marked active while `Client.active_brand_guide_id` still
 * pointed at the old one, and every assertion about the status column would pass
 * while the engine drafted against superseded rules.
 *
 * Nothing is mocked but the cookie jar. There is no Gemini call on this path, so
 * the permissions, the scoping, the database and the audit trail underneath are
 * all real.
 */

let cookieJar: Record<string, string> = {};

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      cookieJar[name] === undefined ? undefined : { name, value: cookieJar[name] },
  }),
}));

// Imported after the mock is registered, so the routes pick it up.
const { POST, PATCH, GET } = await import("@/app/api/brand-guides/route");
const { POST: APPROVE } = await import("@/app/api/brand-guides/[id]/approve/route");

/** CL-102 (Cairo Roast) -- a hero client with a seeded active guide, CR.*. */
const CLIENT = "CL-102";

/** CL-102's account manager: may draft and submit a version, never approve one. */
const AM_EMAIL = "omar.zaki@skipstudio.test";
/** CL-102's client contact: the only role that activates a version. */
const CONTACT_EMAIL = "hisham.adly@skipstudio.test";
/** An account manager who does not manage CL-102. */
const OTHER_AM_EMAIL = "sara.selim@skipstudio.test";
/** A creator on CL-102: may draft content, may not touch the guide. */
const CREATOR_EMAIL = "mona.farid@skipstudio.test";

const versionIds: string[] = [];
const sessionUserIds: string[] = [];

/** The seeded active guide, captured once so cleanup can put it back. */
const originalActiveGuide = new Map<string, string | null>();

async function signIn(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const { token } = await createSession({ userId: user.user_id });
  cookieJar[SESSION_COOKIE] = token;
  sessionUserIds.push(user.user_id);
  return user;
}

async function rememberActiveGuide(clientId: string) {
  if (originalActiveGuide.has(clientId)) return;
  const client = await prisma.client.findUniqueOrThrow({
    where: { client_id: clientId },
    select: { active_brand_guide_id: true },
  });
  originalActiveGuide.set(clientId, client.active_brand_guide_id);
}

function jsonRequest(url: string, body: unknown, method = "POST") {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function create(body: Record<string, unknown>) {
  const response = await POST(jsonRequest("http://localhost/api/brand-guides", body));
  const payload = await response.json();
  if (payload.brand_guide_version_id) versionIds.push(payload.brand_guide_version_id);
  return { response, body: payload };
}

async function submit(versionId: string) {
  const response = await PATCH(
    jsonRequest("http://localhost/api/brand-guides", { brand_guide_version_id: versionId }, "PATCH"),
  );
  return { response, body: await response.json() };
}

async function decide(versionId: string, body: Record<string, unknown> = {}) {
  const response = await APPROVE(
    jsonRequest(`http://localhost/api/brand-guides/${versionId}/approve`, body),
    { params: { id: versionId } },
  );
  return { response, body: await response.json() };
}

/** Two clauses in the shape Cairo Roast's guide uses, so codes stay in family. */
const CLAUSES = [
  { clause_code: "CR.9", title: "Tone", text: "Tone. Warm, never shouty." },
  { clause_code: "CR.10", title: "Origin", text: "Origin. Always name the farm." },
];

/** A version on CL-102, drafted by its account manager. */
async function draftVersion(extra: Record<string, unknown> = {}) {
  await rememberActiveGuide(CLIENT);
  await signIn(AM_EMAIL);
  const { body } = await create({ client_id: CLIENT, clauses: CLAUSES, ...extra });
  return body.brand_guide_version_id as string;
}

afterEach(async () => {
  cookieJar = {};

  // Put the client's active guide back before the versions are deleted, or the
  // seeded guide's row would be orphaned by a cascade from a version this test
  // made active.
  for (const [clientId, guideId] of originalActiveGuide) {
    await prisma.client.update({
      where: { client_id: clientId },
      data: { active_brand_guide_id: guideId },
    });
    // A version this test superseded was the seeded active one; restore it.
    if (guideId) {
      await prisma.brandGuideVersion.update({
        where: { brand_guide_version_id: guideId },
        data: { status: "active" },
      });
    }
  }
  originalActiveGuide.clear();

  await prisma.auditLog.deleteMany({ where: { entity_id: { in: versionIds } } });
  await prisma.guidelineClause.deleteMany({
    where: { brand_guide_version_id: { in: versionIds } },
  });
  await prisma.brandGuideVersion.deleteMany({
    where: { brand_guide_version_id: { in: versionIds } },
  });
  await prisma.flag.deleteMany({ where: { flag_type: "role_boundary_violation" } });

  while (sessionUserIds.length > 0) {
    await prisma.session.deleteMany({ where: { user_id: sessionUserIds.pop()! } });
  }
  versionIds.length = 0;
});

// ---------------------------------------------------------------------------
// Drafting a version
// ---------------------------------------------------------------------------

describe("POST /api/brand-guides", () => {
  it("refuses an unauthenticated request with 401", async () => {
    const { response } = await create({ client_id: CLIENT, clauses: CLAUSES });

    expect(response.status).toBe(401);
  });

  it("lets an account manager draft a version of their client's guide", async () => {
    await rememberActiveGuide(CLIENT);
    await signIn(AM_EMAIL);

    const { response, body } = await create({ client_id: CLIENT, clauses: CLAUSES });

    expect(response.status).toBe(201);
    expect(body.client_id).toBe(CLIENT);
    expect(body.status).toBe("draft");
    expect(body.clauses.map((c: { clause_code: string }) => c.clause_code)).toEqual([
      "CR.10",
      "CR.9",
    ]);
  });

  it("numbers the new version after the client's current highest", async () => {
    // CL-102's seeded guide is version 1, so the first in-app edit is 2.
    const { body } = await (async () => {
      await rememberActiveGuide(CLIENT);
      await signIn(AM_EMAIL);
      return create({ client_id: CLIENT, clauses: CLAUSES });
    })();

    expect(body.version_number).toBe(2);

    const second = await create({ client_id: CLIENT, clauses: CLAUSES });
    expect(second.body.version_number).toBe(3);
  });

  it("does not touch the active guide -- the whole point of the gate", async () => {
    const before = await getGuidelinesForClient(CLIENT);

    await draftVersion();

    const after = await getGuidelinesForClient(CLIENT);

    expect(after.brandGuideVersionId).toBe(before.brandGuideVersionId);
    expect(after.brand.map((c) => c.clause_code)).toEqual(before.brand.map((c) => c.clause_code));
    expect(after.brand.map((c) => c.clause_code)).not.toContain("CR.9");
  });

  it("parses markdown with the seed's own parser", async () => {
    await rememberActiveGuide(CLIENT);
    await signIn(AM_EMAIL);

    const { response, body } = await create({
      client_id: CLIENT,
      markdown: [
        "# Cairo Roast",
        "",
        "**CR.9 — Tone.** Warm, never shouty.",
        "**CR.10 — Origin.** Always name the farm.",
      ].join("\n"),
    });

    expect(response.status).toBe(201);
    // The clause codes are the citation vocabulary; an in-app edit has to
    // produce exactly what a seeded guide does.
    expect(body.clauses.map((c: { clause_code: string }) => c.clause_code)).toEqual([
      "CR.10",
      "CR.9",
    ]);
    expect(body.clauses.find((c: { clause_code: string }) => c.clause_code === "CR.9").text).toBe(
      "Tone. Warm, never shouty.",
    );
  });

  it("rejects a version with no clauses, field-keyed", async () => {
    await signIn(AM_EMAIL);

    const { response, body } = await create({ client_id: CLIENT });

    expect(response.status).toBe(422);
    expect(body.error.issues.clauses).toBeTruthy();
  });

  it("rejects a duplicated clause code rather than letting the index 500", async () => {
    await signIn(AM_EMAIL);

    const { response, body } = await create({
      client_id: CLIENT,
      clauses: [CLAUSES[0], CLAUSES[0]],
    });

    expect(response.status).toBe(422);
    expect(body.error.issues.clauses).toContain("CR.9");
  });

  it("refuses an account manager on a client they do not manage", async () => {
    await signIn(OTHER_AM_EMAIL);

    const { response } = await create({ client_id: CLIENT, clauses: CLAUSES });

    expect(response.status).toBe(403);
  });

  it("refuses a content creator entirely -- the guide is not theirs to edit", async () => {
    await signIn(CREATOR_EMAIL);

    const { response } = await create({ client_id: CLIENT, clauses: CLAUSES });

    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Submitting for approval
// ---------------------------------------------------------------------------

describe("PATCH /api/brand-guides", () => {
  it("moves a draft into the client's queue", async () => {
    const id = await draftVersion();

    const { response, body } = await submit(id);

    expect(response.status).toBe(200);
    expect(body.status).toBe("pending_client_approval");
  });

  it("still does not activate anything", async () => {
    const before = await getGuidelinesForClient(CLIENT);

    const id = await draftVersion();
    await submit(id);

    const after = await getGuidelinesForClient(CLIENT);
    expect(after.brandGuideVersionId).toBe(before.brandGuideVersionId);
  });

  it("refuses submitting a version already with the client, with 409", async () => {
    const id = await draftVersion({ submit_for_approval: true });

    const { response, body } = await submit(id);

    expect(response.status).toBe(409);
    expect(body.error.issues.status).toBe("pending_client_approval");
  });
});

// ---------------------------------------------------------------------------
// The client's sign-off -- the only thing that activates
// ---------------------------------------------------------------------------

describe("POST /api/brand-guides/[id]/approve", () => {
  it("activates the version, and the engine's retrieval scope follows", async () => {
    const before = await getGuidelinesForClient(CLIENT);
    const id = await draftVersion({ submit_for_approval: true });

    await signIn(CONTACT_EMAIL);
    const { response, body } = await decide(id);

    expect(response.status).toBe(200);
    expect(body.status).toBe("active");
    expect(body.client_approved_by_id).toBeTruthy();

    // The claim that matters: not the status column, but what the engine now
    // grounds a draft in.
    const after = await getGuidelinesForClient(CLIENT);
    expect(after.brandGuideVersionId).toBe(id);
    expect(after.brand.map((c) => c.clause_code)).toEqual(["CR.10", "CR.9"]);
    expect(after.brandGuideVersionId).not.toBe(before.brandGuideVersionId);
  });

  it("supersedes the outgoing version, leaving exactly one active", async () => {
    const id = await draftVersion({ submit_for_approval: true });

    await signIn(CONTACT_EMAIL);
    await decide(id);

    const active = await prisma.brandGuideVersion.findMany({
      where: { client_id: CLIENT, status: "active" },
    });
    expect(active).toHaveLength(1);
    expect(active[0].brand_guide_version_id).toBe(id);

    const superseded = await prisma.brandGuideVersion.findMany({
      where: { client_id: CLIENT, status: "superseded" },
    });
    expect(superseded.length).toBeGreaterThan(0);
  });

  it("refuses the account manager who wrote it -- they hold upload, not approve", async () => {
    const id = await draftVersion({ submit_for_approval: true });

    // Still signed in as the account manager.
    const { response } = await decide(id);

    expect(response.status).toBe(403);

    // And nothing moved.
    const scope = await getGuidelinesForClient(CLIENT);
    expect(scope.brandGuideVersionId).not.toBe(id);
  });

  it("refuses another client's contact", async () => {
    const id = await draftVersion({ submit_for_approval: true });

    // A contact on a different client entirely (CL-101's).
    await signIn("rana.fouad@skipstudio.test");
    const { response } = await decide(id);

    expect(response.status).toBe(403);
  });

  it("refuses approving a version never submitted, with 409", async () => {
    const id = await draftVersion();

    await signIn(CONTACT_EMAIL);
    const { response, body } = await decide(id);

    expect(response.status).toBe(409);
    expect(body.error.issues.status).toBe("draft");
  });

  it("sends a declined version back to draft, leaving the active guide alone", async () => {
    const before = await getGuidelinesForClient(CLIENT);
    const id = await draftVersion({ submit_for_approval: true });

    await signIn(CONTACT_EMAIL);
    const { response, body } = await decide(id, {
      decision: "decline",
      comment: "CR.10 is too strict for single-origin blends.",
    });

    expect(response.status).toBe(200);
    expect(body.status).toBe("draft");

    const after = await getGuidelinesForClient(CLIENT);
    expect(after.brandGuideVersionId).toBe(before.brandGuideVersionId);
  });

  it("records who approved, in the audit trail", async () => {
    const id = await draftVersion({ submit_for_approval: true });

    const contact = await signIn(CONTACT_EMAIL);
    await decide(id);

    const rows = await prisma.auditLog.findMany({
      where: { entity_id: id, entity_type: "BrandGuideVersion" },
      orderBy: { performed_at: "asc" },
    });

    expect(rows.map((r) => r.action)).toEqual(["created", "approved"]);
    expect(rows.at(-1)?.performed_by_id).toBe(contact.user_id);
  });
});

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

describe("GET /api/brand-guides", () => {
  it("returns a client's history, newest first", async () => {
    const id = await draftVersion();

    const response = await GET(
      new Request(`http://localhost/api/brand-guides?client_id=${CLIENT}`),
    );
    const body = await response.json();

    expect(body.brand_guide_versions[0].brand_guide_version_id).toBe(id);
    // The seeded version 1 is still there -- superseded versions are kept.
    expect(body.brand_guide_versions.length).toBeGreaterThanOrEqual(2);
  });

  it("returns nothing for a client outside the caller's scope", async () => {
    await draftVersion();

    await signIn(OTHER_AM_EMAIL);
    const response = await GET(
      new Request(`http://localhost/api/brand-guides?client_id=${CLIENT}`),
    );
    const body = await response.json();

    // A client_id in the URL narrows the session's scope; it can never widen it.
    expect(body.brand_guide_versions).toEqual([]);
  });
});
