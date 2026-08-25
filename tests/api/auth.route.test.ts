import { describe, it, expect, afterEach, vi } from "vitest";

import { SESSION_COOKIE } from "@/api/request";
import { prisma } from "@/db";
import { issueOtp } from "@/domain/otp";
import { hashWithoutPolicy, verifyPassword } from "@/domain/password";
import { createSession, resolveSession } from "@/domain/session";

/**
 * The sign-in, sign-out and password endpoints.
 *
 * The credential rules themselves live in `lib/domain/password.test.ts`,
 * `otp.test.ts` and `session.test.ts`. What is tested here is only what the
 * routes add: that a session cookie is actually set, that every failure looks
 * identical from outside, that a redeemed code cannot reach past the password
 * screen, and that setting a password ends the sessions that knew the old one.
 *
 * `next/headers` is mocked because `cookies()` needs a request scope only the
 * server provides. Response cookies are read off the real `NextResponse`.
 */

let cookieJar: Record<string, string> = {};

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      cookieJar[name] === undefined ? undefined : { name, value: cookieJar[name] },
  }),
}));

const { POST: signin } = await import("@/app/api/auth/signin/route");
const { POST: signout } = await import("@/app/api/auth/signout/route");
const { POST: setPassword } = await import("@/app/api/auth/password/route");

/** The password every seeded account shares. Printed by `npm run db:seed`. */
const DEV_PASSWORD = "skipstudio-dev";

/** The seeded contact left un-activated so the OTP path is real, not synthetic. */
const INVITED_EMAIL = "ahmed.rifaat@skipstudio.test";

const AM_EMAIL = "sara.selim@skipstudio.test";

function post(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const touchedUsers = new Set<string>();

/**
 * Put the seed back.
 *
 * These tests redeem the invited contact's code and change passwords, both of
 * which mutate rows the rest of the suite asserts against -- the README
 * documents `ahmed.rifaat` as having no password at all, and
 * `clients.route.test.ts` signs in with the shared dev password. Restoration is
 * keyed on the user id, which survives the sessions and codes being deleted.
 */
afterEach(async () => {
  cookieJar = {};

  const hash = await hashWithoutPolicy(DEV_PASSWORD);

  for (const userId of touchedUsers) {
    await prisma.session.deleteMany({ where: { user_id: userId } });
    await prisma.loginOtp.deleteMany({ where: { user_id: userId } });
    await prisma.auditLog.deleteMany({ where: { entity_type: "User", entity_id: userId } });

    const user = await prisma.user.findUnique({ where: { user_id: userId } });
    if (!user) continue;

    // The invited contact goes back to having no password at all; everyone else
    // back to the shared dev password.
    await prisma.user.update({
      where: { user_id: userId },
      data:
        user.email === INVITED_EMAIL
          ? { password_hash: null, status: "invited", must_change_password: false }
          : { password_hash: hash, status: "active", must_change_password: false },
    });
  }
  touchedUsers.clear();

  await prisma.auditLog.deleteMany({ where: { entity_type: "LoginOtp" } });
});

async function userByEmail(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  touchedUsers.add(user.user_id);
  return user;
}

/** The session token the route set, read off the response rather than guessed. */
function cookieFrom(response: Response): string | undefined {
  return (
    response as unknown as { cookies?: { get(n: string): { value: string } | undefined } }
  ).cookies?.get(SESSION_COOKIE)?.value;
}

describe("POST /api/auth/signin", () => {
  it("signs in with a password and sets a resolvable session cookie", async () => {
    await userByEmail(AM_EMAIL);

    const response = await signin(
      post("/api/auth/signin", { email: AM_EMAIL, password: DEV_PASSWORD }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user.must_change_password).toBe(false);

    // The cookie must resolve to the user, not merely exist. A route that set a
    // cookie the session layer cannot read would pass a shallower assertion and
    // fail every subsequent request.
    const token = cookieFrom(response);
    expect(token).toBeTruthy();
    const resolved = await resolveSession(token);
    expect(resolved?.user.email).toBe(AM_EMAIL);
  });

  it("refuses a wrong password with 401 and no cookie", async () => {
    await userByEmail(AM_EMAIL);

    const response = await signin(
      post("/api/auth/signin", { email: AM_EMAIL, password: "not-the-password" }),
    );

    expect(response.status).toBe(401);
    expect(cookieFrom(response)).toBeFalsy();
  });

  /**
   * The property the single endpoint exists for. If these two answers ever
   * differ, the response tells a prober which addresses hold accounts.
   */
  it("gives an unknown email and a wrong password the identical answer", async () => {
    await userByEmail(AM_EMAIL);

    const unknown = await signin(
      post("/api/auth/signin", { email: "nobody@skipstudio.test", password: DEV_PASSWORD }),
    );
    const wrong = await signin(
      post("/api/auth/signin", { email: AM_EMAIL, password: "wrong" }),
    );

    expect(unknown.status).toBe(wrong.status);
    expect((await unknown.json()).error).toEqual((await wrong.json()).error);
  });

  it("refuses an invited contact who has no password yet", async () => {
    await userByEmail(INVITED_EMAIL);

    const response = await signin(
      post("/api/auth/signin", { email: INVITED_EMAIL, password: DEV_PASSWORD }),
    );

    expect(response.status).toBe(401);
  });

  it("signs in with a one-time code and reports that a password is still needed", async () => {
    const contact = await userByEmail(INVITED_EMAIL);
    const manager = await userByEmail(AM_EMAIL);
    const { code } = await issueOtp({
      userId: contact.user_id,
      byAccountManagerId: manager.user_id,
    });

    const response = await signin(post("/api/auth/signin", { email: INVITED_EMAIL, code }));

    expect(response.status).toBe(200);
    const body = await response.json();
    // The whole point of the flag: the browser is sent to `/password`, not to a
    // role home, and `requireUser` refuses this session everywhere else.
    expect(body.user.must_change_password).toBe(true);

    const resolved = await resolveSession(cookieFrom(response));
    expect(resolved?.user.must_change_password).toBe(true);
  });

  it("refuses a code that was already redeemed", async () => {
    const contact = await userByEmail(INVITED_EMAIL);
    const { code } = await issueOtp({ userId: contact.user_id });

    await signin(post("/api/auth/signin", { email: INVITED_EMAIL, code }));
    const second = await signin(post("/api/auth/signin", { email: INVITED_EMAIL, code }));

    expect(second.status).toBe(401);
  });

  it("refuses a request with neither password nor code", async () => {
    const response = await signin(post("/api/auth/signin", { email: AM_EMAIL }));
    expect(response.status).toBe(401);
  });
});

describe("POST /api/auth/signout", () => {
  it("revokes the session so the token stops resolving", async () => {
    const user = await userByEmail(AM_EMAIL);
    const { token } = await createSession({ userId: user.user_id });
    cookieJar[SESSION_COOKIE] = token;

    expect(await resolveSession(token)).not.toBeNull();

    const response = await signout();
    expect(response.status).toBe(200);

    // Revoked server-side, not merely cleared in the browser. A sign-out that
    // only dropped the cookie would leave the token live for anyone who kept it.
    expect(await resolveSession(token)).toBeNull();
  });

  it("is idempotent with no session at all", async () => {
    expect((await signout()).status).toBe(200);
  });
});

describe("POST /api/auth/password", () => {
  it("refuses when nobody is signed in", async () => {
    const response = await setPassword(
      post("/api/auth/password", { new_password: "a-new-password" }),
    );

    expect(response.status).toBe(401);
  });

  it("lets a redeemed contact set a first password without a current one", async () => {
    const contact = await userByEmail(INVITED_EMAIL);
    const { code } = await issueOtp({ userId: contact.user_id });

    const signedIn = await signin(post("/api/auth/signin", { email: INVITED_EMAIL, code }));
    cookieJar[SESSION_COOKIE] = cookieFrom(signedIn)!;

    const response = await setPassword(
      post("/api/auth/password", { new_password: "chosen-by-the-contact" }),
    );

    expect(response.status).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { user_id: contact.user_id } });
    expect(after.must_change_password).toBe(false);
    expect(await verifyPassword("chosen-by-the-contact", after.password_hash)).toBe(true);
  });

  it("requires the current password from a user who already holds one", async () => {
    const user = await userByEmail(AM_EMAIL);
    const { token } = await createSession({ userId: user.user_id });
    cookieJar[SESSION_COOKIE] = token;

    const response = await setPassword(
      post("/api/auth/password", {
        new_password: "a-long-enough-password",
        current_password: "not-it",
      }),
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("CURRENT_PASSWORD_WRONG");

    // And the password is unchanged.
    const after = await prisma.user.findUniqueOrThrow({ where: { user_id: user.user_id } });
    expect(await verifyPassword(DEV_PASSWORD, after.password_hash)).toBe(true);
  });

  it("refuses a password below the minimum length", async () => {
    const user = await userByEmail(AM_EMAIL);
    const { token } = await createSession({ userId: user.user_id });
    cookieJar[SESSION_COOKIE] = token;

    const response = await setPassword(
      post("/api/auth/password", { new_password: "short", current_password: DEV_PASSWORD }),
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error.issues.new_password).toBeTruthy();
  });

  /**
   * The reason the endpoint revokes rather than just updating. If the password
   * is being changed because someone else got in, leaving their session live
   * makes the change cosmetic.
   */
  it("ends every other session and re-issues one for the caller", async () => {
    const user = await userByEmail(AM_EMAIL);
    const elsewhere = await createSession({ userId: user.user_id });
    const here = await createSession({ userId: user.user_id });
    cookieJar[SESSION_COOKIE] = here.token;

    const response = await setPassword(
      post("/api/auth/password", {
        new_password: "a-long-enough-password",
        current_password: DEV_PASSWORD,
      }),
    );

    expect(response.status).toBe(200);
    expect(await resolveSession(elsewhere.token)).toBeNull();
    expect(await resolveSession(here.token)).toBeNull();

    // The caller gets a working session back, or setting a password would bounce
    // them to sign-in on their next click.
    const replacement = cookieFrom(response);
    expect(await resolveSession(replacement)).not.toBeNull();
  });
});
