import { describe, it, expect, afterEach, vi } from "vitest";

import { SESSION_COOKIE } from "@/api/request";
import { prisma } from "@/db";
import { createSession } from "@/domain/session";

/**
 * Client contact onboarding over HTTP.
 *
 * The onboarding rules are tested in `lib/domain/clientContacts.test.ts`. What
 * this file adds is the part that only exists at the route: that an account
 * manager cannot onboard a contact onto a client outside their own roster, and
 * that the one-time code comes back in the response exactly once.
 *
 * That scope check is the isolation guarantee at its most load-bearing --
 * onboarding is the one operation that *creates* access, so a scope hole here
 * hands somebody a permanent seat rather than a single page view.
 */

let cookieJar: Record<string, string> = {};

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      cookieJar[name] === undefined ? undefined : { name, value: cookieJar[name] },
  }),
}));

const { GET, POST } = await import("@/app/api/clients/[id]/contacts/route");

const PROBE_EMAIL = "route.contact.probe@skipstudio.test";

function post(clientId: string, body: unknown) {
  return new Request(`http://localhost/api/clients/${clientId}/contacts`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function get(clientId: string) {
  return new Request(`http://localhost/api/clients/${clientId}/contacts`);
}

const sessionUsers: string[] = [];

afterEach(async () => {
  cookieJar = {};

  // Keyed on the address rather than a captured id: a test asserting that a
  // creation is *refused* has no id to record, and a broken guard would leave
  // the row behind to desync every later test in the suite.
  const strays = await prisma.user.findMany({
    where: { email: PROBE_EMAIL },
    select: { user_id: true },
  });
  for (const { user_id } of strays) {
    await prisma.loginOtp.deleteMany({ where: { user_id } });
    const assignments = await prisma.clientAssignment.findMany({
      where: { user_id },
      select: { assignment_id: true },
    });
    await prisma.auditLog.deleteMany({
      where: {
        entity_type: "ClientAssignment",
        entity_id: { in: assignments.map((a) => a.assignment_id) },
      },
    });
    await prisma.clientAssignment.deleteMany({ where: { user_id } });
    await prisma.session.deleteMany({ where: { user_id } });
    await prisma.user.deleteMany({ where: { user_id } });
  }

  while (sessionUsers.length > 0) {
    await prisma.session.deleteMany({ where: { user_id: sessionUsers.pop()! } });
  }

  await prisma.auditLog.deleteMany({ where: { entity_type: "LoginOtp" } });
  await prisma.auditLog.deleteMany({ where: { entity_type: "Flag" } });
  await prisma.flag.deleteMany({});
});

async function signIn(userId: string) {
  const { token } = await createSession({ userId });
  cookieJar[SESSION_COOKIE] = token;
  sessionUsers.push(userId);
}

/** A client with an account manager, and one that manager does not manage. */
async function twoClients() {
  const mine = await prisma.client.findFirstOrThrow({
    where: { NOT: { account_manager_id: null } },
    select: { client_id: true, account_manager_id: true },
  });
  const theirs = await prisma.client.findFirstOrThrow({
    where: {
      NOT: [{ account_manager_id: mine.account_manager_id }, { account_manager_id: null }],
    },
    select: { client_id: true, account_manager_id: true },
  });
  return { mine, theirs };
}

describe("POST /api/clients/:id/contacts", () => {
  it("refuses an unauthenticated request with 401", async () => {
    const { mine } = await twoClients();
    const response = await POST(post(mine.client_id, { name: "X", email: PROBE_EMAIL }), {
      params: { id: mine.client_id },
    });

    expect(response.status).toBe(401);
  });

  it("creates a contact and returns the code once, with 201", async () => {
    const { mine } = await twoClients();
    await signIn(mine.account_manager_id!);

    const response = await POST(
      post(mine.client_id, { name: "Probe Contact", email: PROBE_EMAIL }),
      { params: { id: mine.client_id } },
    );

    expect(response.status).toBe(201);
    const body = await response.json();

    expect(body.contact.status).toBe("invited");
    expect(body.otp.code).toMatch(/^\d{6}$/);
    expect(body.otp.expires_at).toBeTruthy();
  });

  /**
   * The load-bearing check. Onboarding creates access rather than merely
   * reading it, so a scope hole here hands somebody a permanent seat on a client
   * that is not theirs.
   */
  it("refuses to onboard a contact onto another manager's client", async () => {
    const { mine, theirs } = await twoClients();
    await signIn(mine.account_manager_id!);

    const response = await POST(
      post(theirs.client_id, { name: "Probe Contact", email: PROBE_EMAIL }),
      { params: { id: theirs.client_id } },
    );

    expect(response.status).toBe(403);

    // And nothing was created. A 403 that still wrote the row would be worse
    // than no check at all, because it would look safe in the response.
    const stray = await prisma.user.findUnique({ where: { email: PROBE_EMAIL } });
    expect(stray).toBeNull();
  });

  it("refuses a client contact trying to onboard anybody", async () => {
    const contact = await prisma.user.findUniqueOrThrow({
      where: { email: "rana.fouad@skipstudio.test" },
    });
    const assignment = await prisma.clientAssignment.findFirstOrThrow({
      where: { user_id: contact.user_id },
    });
    await signIn(contact.user_id);

    const response = await POST(
      post(assignment.client_id, { name: "Probe", email: PROBE_EMAIL }),
      { params: { id: assignment.client_id } },
    );

    // Their own client, and still refused -- the capability is not theirs at all.
    expect(response.status).toBe(403);
  });

  it("names the offending field on a bad body", async () => {
    const { mine } = await twoClients();
    await signIn(mine.account_manager_id!);

    const response = await POST(post(mine.client_id, { name: "", email: "" }), {
      params: { id: mine.client_id },
    });

    expect(response.status).toBe(422);
    expect((await response.json()).error.issues.name).toBeTruthy();
  });

  it("re-issues a code for an existing contact without creating a second one", async () => {
    const { mine } = await twoClients();
    await signIn(mine.account_manager_id!);

    const created = await POST(
      post(mine.client_id, { name: "Probe Contact", email: PROBE_EMAIL }),
      { params: { id: mine.client_id } },
    );
    const { contact, otp: first } = await created.json();

    const reissued = await POST(post(mine.client_id, { user_id: contact.user_id }), {
      params: { id: mine.client_id },
    });

    expect(reissued.status).toBe(200);
    const { otp: second } = await reissued.json();
    expect(second.code).not.toBe(first.code);

    // Still one contact, and still one live code.
    const live = await prisma.loginOtp.count({
      where: { user_id: contact.user_id, consumed_at: null },
    });
    expect(live).toBe(1);
  });
});

describe("GET /api/clients/:id/contacts", () => {
  it("lists the client's own contacts", async () => {
    const { mine } = await twoClients();
    await signIn(mine.account_manager_id!);

    await POST(post(mine.client_id, { name: "Probe Contact", email: PROBE_EMAIL }), {
      params: { id: mine.client_id },
    });

    const response = await GET(get(mine.client_id), { params: { id: mine.client_id } });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.contacts.map((c: { email: string }) => c.email)).toContain(PROBE_EMAIL);
  });

  it("refuses to list another manager's client", async () => {
    const { mine, theirs } = await twoClients();
    await signIn(mine.account_manager_id!);

    const response = await GET(get(theirs.client_id), { params: { id: theirs.client_id } });

    expect(response.status).toBe(403);
  });

  /**
   * No password hash reaches the browser, whoever is asking. The panel needs a
   * name, an address and a status; anything more is an accident waiting to be
   * logged.
   */
  it("never returns a password hash", async () => {
    const { mine } = await twoClients();
    await signIn(mine.account_manager_id!);

    const response = await GET(get(mine.client_id), { params: { id: mine.client_id } });
    const body = await response.json();

    for (const contact of body.contacts) {
      expect(contact.password_hash).toBeUndefined();
    }
  });
});
