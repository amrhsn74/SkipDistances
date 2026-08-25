import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

import { prisma } from "@/db";
import { SESSION_COOKIE } from "@/api/request";
import { createSession } from "@/domain/session";

/**
 * The HTTP shell over `clientRoster`.
 *
 * The rules themselves are tested in `lib/domain/clientRoster.test.ts`. What is
 * tested here is only what the route adds: that the acting user comes from the
 * session cookie and nowhere else, that a denial is a 403 rather than a 500 or a
 * 200, and that a validation failure names its fields.
 *
 * `next/headers` is mocked because `cookies()` needs a request scope that only
 * the server provides. The mock is the one seam; everything downstream of it is
 * the real route, the real permission check and the real database.
 */

let cookieJar: Record<string, string> = {};

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      cookieJar[name] === undefined ? undefined : { name, value: cookieJar[name] },
  }),
}));

// Imported after the mock is registered, so the route picks it up.
const { GET, POST } = await import("@/app/api/clients/route");

async function signIn(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const { token } = await createSession({ userId: user.user_id });
  cookieJar[SESSION_COOKIE] = token;
  return user;
}

function signOut() {
  cookieJar = {};
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api/clients", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let egyptId = "";
const createdClients: string[] = [];
const createdSessionUsers: string[] = [];

beforeAll(async () => {
  egyptId = (await prisma.market.findFirstOrThrow({ where: { country_code: "EG" } })).market_id;
});

/**
 * Every client this file posts uses one of these names.
 *
 * Cleanup keys on the name rather than only on the ids the tests captured: a
 * test asserting that a POST is *refused* has no id to record, and if the guard
 * it is testing ever breaks, the row it should not have created would survive
 * the run and desync the seeded roster for every other test file. Cleaning by
 * name means a broken guard fails its own test without corrupting the rest.
 */
const TEST_CLIENT_NAMES = ["Route Test Co", "Should Not Exist", "Probe"];

afterEach(async () => {
  signOut();

  const strays = await prisma.client.findMany({
    where: { name: { in: TEST_CLIENT_NAMES } },
    select: { client_id: true },
  });
  for (const { client_id } of [...strays, ...createdClients.map((c) => ({ client_id: c }))]) {
    await prisma.auditLog.deleteMany({ where: { entity_type: "Client", entity_id: client_id } });
    await prisma.client.deleteMany({ where: { client_id } });
  }
  createdClients.length = 0;

  // Keyed on the actor id, which survives the rows being deleted.
  while (createdSessionUsers.length > 0) {
    await prisma.session.deleteMany({ where: { user_id: createdSessionUsers.pop()! } });
  }

  await prisma.auditLog.deleteMany({ where: { entity_type: "Flag" } });
  await prisma.flag.deleteMany({});
});

async function signInTracked(email: string) {
  const user = await signIn(email);
  createdSessionUsers.push(user.user_id);
  return user;
}

describe("GET /api/clients", () => {
  it("refuses an unauthenticated request with 401", async () => {
    const response = await GET();

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("refuses a forged cookie rather than trusting it", async () => {
    cookieJar[SESSION_COOKIE] = "not-a-real-token";

    expect((await GET()).status).toBe(401);
  });

  it("returns the whole roster to an agency admin", async () => {
    await signInTracked("hala.mansour@skipstudio.test");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.clients.length).toBe(await prisma.client.count());
  });

  it("returns exactly one client to a client contact", async () => {
    await signInTracked("rana.fouad@skipstudio.test");

    const body = await (await GET()).json();

    expect(body.clients).toHaveLength(1);
    expect(body.clients[0].client_id).toBe("CL-101");
  });
});

describe("POST /api/clients", () => {
  it("creates a client for an account manager and answers 201", async () => {
    const manager = await prisma.client.findFirstOrThrow({
      where: { NOT: { account_manager_id: null } },
      select: { account_manager_id: true },
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { user_id: manager.account_manager_id! },
    });
    const { token } = await createSession({ userId: user.user_id });
    cookieJar[SESSION_COOKIE] = token;
    createdSessionUsers.push(user.user_id);

    const response = await POST(
      postRequest({
        name: "Route Test Co",
        industry: "retail",
        market_ids: [egyptId],
        channels: ["instagram"],
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.client.name).toBe("Route Test Co");
    expect(body.client.markets.map((m: { country_code: string }) => m.country_code)).toEqual(["EG"]);
    createdClients.push(body.client.client_id);

    // Actually persisted, not just echoed back.
    expect(await prisma.client.findUnique({ where: { client_id: body.client.client_id } }))
      .not.toBeNull();
  });

  it("refuses a client contact with 403 and creates nothing", async () => {
    await signInTracked("rana.fouad@skipstudio.test");
    const before = await prisma.client.count();

    const response = await POST(
      postRequest({ name: "Should Not Exist", industry: "retail", market_ids: [egyptId] }),
    );

    expect(response.status).toBe(403);
    expect(await prisma.client.count()).toBe(before);
  });

  it("records a role_boundary_violation flag when it refuses", async () => {
    const contact = await signInTracked("rana.fouad@skipstudio.test");

    await POST(postRequest({ name: "Probe", industry: "retail", market_ids: [egyptId] }));

    const flags = await prisma.flag.findMany({
      where: { flag_type: "role_boundary_violation", raised_against_id: contact.user_id },
    });
    expect(flags.length).toBeGreaterThan(0);
  });

  it("answers 422 with the offending fields named", async () => {
    await signInTracked("hala.mansour@skipstudio.test");
    // The admin cannot create clients, so use a manager for a validation path.
    signOut();

    const managed = await prisma.client.findFirstOrThrow({
      where: { NOT: { account_manager_id: null } },
      select: { account_manager_id: true },
    });
    const { token } = await createSession({ userId: managed.account_manager_id! });
    cookieJar[SESSION_COOKIE] = token;
    createdSessionUsers.push(managed.account_manager_id!);

    const response = await POST(postRequest({ name: "", industry: "retail", market_ids: [] }));
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(Object.keys(body.error.issues).sort()).toEqual(["marketIds", "name"]);
  });

  it("answers 400 for a malformed body rather than 500", async () => {
    const managed = await prisma.client.findFirstOrThrow({
      where: { NOT: { account_manager_id: null } },
      select: { account_manager_id: true },
    });
    const { token } = await createSession({ userId: managed.account_manager_id! });
    cookieJar[SESSION_COOKIE] = token;
    createdSessionUsers.push(managed.account_manager_id!);

    const response = await POST(postRequest("{not json"));

    expect(response.status).toBe(400);
  });
});
