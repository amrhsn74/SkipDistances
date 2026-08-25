import { describe, it, expect, beforeEach, afterAll } from "vitest";

import { prisma } from "../db";
import {
  SESSION_TTL_HOURS,
  SessionDeniedError,
  createSession,
  generateToken,
  hashToken,
  resolveSession,
  revokeAllSessions,
  revokeSession,
} from "./session";

/**
 * The property that justifies server-side sessions over a self-describing
 * token: withdrawal is immediate. A disabled account, a sign-out, or a password
 * change must stop working on the next request rather than at the token's next
 * expiry. Most of what follows tests that, not the happy path.
 */

const STAFF = "TEST-SESSION-STAFF";
const STAFF_EMAIL = "test-session-staff@skipstudio.test";
const INVITED = "TEST-SESSION-INVITED";
const INVITED_EMAIL = "test-session-invited@skipstudio.test";

const USERS = [STAFF, INVITED];

async function clearSessions() {
  await prisma.session.deleteMany({ where: { user_id: { in: USERS } } });
}

beforeEach(async () => {
  await clearSessions();

  await prisma.user.upsert({
    where: { user_id: STAFF },
    update: { status: "active", must_change_password: false, last_login_at: null },
    create: {
      user_id: STAFF,
      name: "Test Session Staff",
      email: STAFF_EMAIL,
      user_type: "staff",
    },
  });

  await prisma.user.upsert({
    where: { user_id: INVITED },
    update: { status: "invited" },
    create: {
      user_id: INVITED,
      name: "Test Session Invited",
      email: INVITED_EMAIL,
      user_type: "client_contact",
      status: "invited",
    },
  });
});

afterAll(async () => {
  await clearSessions();
  await prisma.user.deleteMany({ where: { user_id: { in: USERS } } });
});

describe("tokens", () => {
  it("are long, random and unique", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => generateToken()));

    expect(tokens.size).toBe(100);
    for (const t of tokens) expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hash deterministically, so a token can be looked up", () => {
    const token = generateToken();

    // Unlike a password hash, this must be stable: resolving a session is an
    // indexed lookup by digest, not a scan-and-verify over every row.
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken(generateToken()));
    expect(hashToken(token)).not.toBe(token);
  });
});

describe("createSession", () => {
  it("stores the token hashed, never in the clear", async () => {
    const { token, sessionId } = await createSession({ userId: STAFF });

    const row = await prisma.session.findUniqueOrThrow({ where: { session_id: sessionId } });

    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).toBe(hashToken(token));
    // A leaked table must yield nothing usable -- no column may carry the raw
    // token, including one added later.
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("records the sign-in time", async () => {
    const before = Date.now();
    await createSession({ userId: STAFF });

    const user = await prisma.user.findUniqueOrThrow({ where: { user_id: STAFF } });
    expect(user.last_login_at).not.toBeNull();
    expect(user.last_login_at!.getTime()).toBeGreaterThanOrEqual(before - 1_000);
  });

  it("expires within the TTL", async () => {
    const before = Date.now();
    const { expiresAt } = await createSession({ userId: STAFF });

    expect(expiresAt.getTime()).toBeGreaterThan(before);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(
      before + SESSION_TTL_HOURS * 3_600_000 + 5_000,
    );
  });

  it("refuses an invited user, who has not chosen a password yet", async () => {
    // Redeeming an OTP activates the account; until then there is no password,
    // so there is nothing a session could be the consequence of.
    await expect(createSession({ userId: INVITED })).rejects.toThrow(SessionDeniedError);
  });

  it("refuses a disabled user and an unknown user", async () => {
    await prisma.user.update({ where: { user_id: STAFF }, data: { status: "disabled" } });
    await expect(createSession({ userId: STAFF })).rejects.toThrow(SessionDeniedError);

    await expect(createSession({ userId: "NO-SUCH-USER" })).rejects.toThrow(
      SessionDeniedError,
    );
  });

  it("issues a distinct token each time, so two devices do not share one", async () => {
    const a = await createSession({ userId: STAFF });
    const b = await createSession({ userId: STAFF });

    expect(a.token).not.toBe(b.token);
    expect((await resolveSession(a.token))?.sessionId).toBe(a.sessionId);
    expect((await resolveSession(b.token))?.sessionId).toBe(b.sessionId);
  });
});

describe("resolveSession", () => {
  it("resolves a live token to the acting user", async () => {
    const { token, sessionId } = await createSession({ userId: STAFF });

    const resolved = await resolveSession(token);

    expect(resolved).not.toBeNull();
    expect(resolved!.sessionId).toBe(sessionId);
    expect(resolved!.userId).toBe(STAFF);
    expect(resolved!.user.email).toBe(STAFF_EMAIL);
    expect(resolved!.user.user_type).toBe("staff");
  });

  it("returns null for a missing, empty or unknown token", async () => {
    expect(await resolveSession(null)).toBeNull();
    expect(await resolveSession(undefined)).toBeNull();
    expect(await resolveSession("")).toBeNull();
    expect(await resolveSession(generateToken())).toBeNull();
  });

  it("returns null for the stored hash presented as a token", async () => {
    const { token } = await createSession({ userId: STAFF });

    // Someone who read the table holds the digest, not the token. Presenting it
    // must not work -- otherwise hashing bought nothing.
    expect(await resolveSession(hashToken(token))).toBeNull();
  });

  it("returns null once revoked", async () => {
    const { token } = await createSession({ userId: STAFF });
    expect(await resolveSession(token)).not.toBeNull();

    await revokeSession(token);
    expect(await resolveSession(token)).toBeNull();
  });

  it("returns null once expired", async () => {
    const { token, sessionId } = await createSession({ userId: STAFF });
    await prisma.session.update({
      where: { session_id: sessionId },
      data: { expires_at: new Date(Date.now() - 1_000) },
    });

    expect(await resolveSession(token)).toBeNull();
  });

  it("stops resolving the moment the user is disabled", async () => {
    const { token } = await createSession({ userId: STAFF });
    expect(await resolveSession(token)).not.toBeNull();

    await prisma.user.update({ where: { user_id: STAFF }, data: { status: "disabled" } });

    // The session row is untouched -- still live, still unexpired. This is the
    // whole reason sessions are server-side: an admin disabling an account must
    // not have to wait for a token to expire.
    const row = await prisma.session.findFirstOrThrow({ where: { user_id: STAFF } });
    expect(row.revoked_at).toBeNull();
    expect(row.expires_at.getTime()).toBeGreaterThan(Date.now());

    expect(await resolveSession(token)).toBeNull();
  });

  it("reports must_change_password as it currently stands", async () => {
    const { token } = await createSession({ userId: STAFF });
    expect((await resolveSession(token))!.user.must_change_password).toBe(false);

    await prisma.user.update({
      where: { user_id: STAFF },
      data: { must_change_password: true },
    });

    // Read fresh on every request, so the middleware that gates on this cannot
    // be outrun by a session created before the flag was set.
    expect((await resolveSession(token))!.user.must_change_password).toBe(true);
  });
});

describe("revokeSession", () => {
  it("reports whether a live session was actually ended", async () => {
    const { token } = await createSession({ userId: STAFF });

    expect(await revokeSession(token)).toBe(true);
    // Idempotent: a double-clicked sign-out must not error.
    expect(await revokeSession(token)).toBe(false);
    expect(await revokeSession(generateToken())).toBe(false);
    expect(await revokeSession(null)).toBe(false);
  });

  it("ends only the session presented, not the user's others", async () => {
    const a = await createSession({ userId: STAFF });
    const b = await createSession({ userId: STAFF });

    await revokeSession(a.token);

    // Signing out on one device must not sign the user out everywhere.
    expect(await resolveSession(a.token)).toBeNull();
    expect(await resolveSession(b.token)).not.toBeNull();
  });
});

describe("revokeAllSessions", () => {
  it("ends every live session, for a password change or a disable", async () => {
    const a = await createSession({ userId: STAFF });
    const b = await createSession({ userId: STAFF });

    expect(await revokeAllSessions(STAFF)).toBe(2);

    expect(await resolveSession(a.token)).toBeNull();
    expect(await resolveSession(b.token)).toBeNull();
  });

  it("counts only sessions it actually ended", async () => {
    const a = await createSession({ userId: STAFF });
    await revokeSession(a.token);
    await createSession({ userId: STAFF });

    expect(await revokeAllSessions(STAFF)).toBe(1);
    expect(await revokeAllSessions(STAFF)).toBe(0);
  });
});
