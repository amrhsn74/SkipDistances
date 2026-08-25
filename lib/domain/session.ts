import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { prisma, type Db } from "../db";

/**
 * Server-side sessions.
 *
 * Deliberately not a self-describing token (a JWT or a signed cookie). A token
 * that carries its own claims cannot be withdrawn: disabling an account or
 * signing out would take effect at the token's next expiry rather than at once.
 * Here every request re-reads the row and the user, so both are immediate.
 *
 * The token is stored hashed, so a leaked `Session` table yields nothing usable.
 *
 * Note the hash is SHA-256, not the scrypt used for passwords — the opposite of
 * the usual advice, and deliberate. scrypt salts every hash, which makes a
 * stored value impossible to look up: resolving would mean scanning every
 * session row and running a deliberately-slow KDF against each, on every
 * request. The reason a password needs a slow salted KDF is that people choose
 * guessable passwords. This token is 256 bits from `randomBytes` — there is no
 * dictionary to try and nothing to precompute, so a fast digest gives up no
 * real strength and keeps resolution a single indexed lookup.
 */

/** 32 bytes. Far beyond guessing; the hex form is what lands in the cookie. */
const TOKEN_BYTES = 32;

export const SESSION_TTL_HOURS = 12;

/** Statuses that may hold a session. `invited` has not set a password yet. */
const SIGNED_IN_STATUSES = new Set(["active"]);

export type CreatedSession = {
  sessionId: string;
  /** The raw token, returned once. Store it in the cookie; never log it. */
  token: string;
  expiresAt: Date;
};

/** What a resolved session tells a request about who is asking. */
export type ResolvedSession = {
  sessionId: string;
  userId: string;
  user: {
    user_id: string;
    name: string;
    email: string;
    user_type: string;
    is_agency_admin: boolean;
    must_change_password: boolean;
    status: string;
  };
  expiresAt: Date;
};

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

/**
 * The stored form of a token.
 *
 * Unsalted on purpose — see the note above. Exported so tests can assert that
 * what is persisted is the digest and never the token itself.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type CreateSessionInput = {
  userId: string;
  ttlHours?: number;
};

export class SessionDeniedError extends Error {
  readonly code = "SESSION_DENIED";
  constructor(message: string) {
    super(message);
    this.name = "SessionDeniedError";
  }
}

/**
 * Sign a user in.
 *
 * Refuses anyone not `active`: an `invited` contact has redeemed a code but not
 * yet chosen a password, and a `disabled` account must not gain a new session
 * even if the caller's credential check somehow passed.
 *
 * Credential verification is the caller's job (the sign-in route). This function
 * is what happens *after* a password verified — keeping it separate means the
 * OTP flow and the password flow share one definition of what a session is.
 */
export async function createSession(
  input: CreateSessionInput,
  db: Db = prisma,
): Promise<CreatedSession> {
  const { userId, ttlHours = SESSION_TTL_HOURS } = input;

  const user = await db.user.findUnique({ where: { user_id: userId } });
  if (!user) throw new SessionDeniedError(`No user ${userId}.`);
  if (!SIGNED_IN_STATUSES.has(user.status)) {
    throw new SessionDeniedError(
      `User ${userId} is ${user.status} and cannot hold a session.`,
    );
  }

  const token = generateToken();
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

  const created = await db.session.create({
    data: {
      user_id: userId,
      token_hash: hashToken(token),
      expires_at: expiresAt,
    },
  });

  await db.user.update({
    where: { user_id: userId },
    data: { last_login_at: new Date() },
  });

  return { sessionId: created.session_id, token, expiresAt };
}

/**
 * Resolve a raw token to the acting user, or null.
 *
 * Null covers every failure — unknown, revoked, expired, disabled user. A caller
 * deciding what to do about an unauthenticated request does not benefit from
 * knowing which, and returning a reason invites it being shown to the browser.
 *
 * The user's current row is read on every resolve rather than trusted from when
 * the session was created. That is the whole point of server-side sessions:
 * disabling an account takes effect on the next request, not at expiry.
 */
export async function resolveSession(
  token: string | null | undefined,
  db: Db = prisma,
): Promise<ResolvedSession | null> {
  if (!token) return null;

  const session = await db.session.findUnique({
    where: { token_hash: hashToken(token) },
    include: { user: true },
  });
  if (!session) return null;

  // Redundant given the indexed lookup above, but a constant-time compare costs
  // nothing here and keeps the comparison honest if the lookup ever changes.
  if (!tokensMatch(session.token_hash, hashToken(token))) return null;

  if (session.revoked_at !== null) return null;
  if (session.expires_at.getTime() <= Date.now()) return null;
  if (!SIGNED_IN_STATUSES.has(session.user.status)) return null;

  return {
    sessionId: session.session_id,
    userId: session.user_id,
    user: {
      user_id: session.user.user_id,
      name: session.user.name,
      email: session.user.email,
      user_type: session.user.user_type,
      is_agency_admin: session.user.is_agency_admin,
      must_change_password: session.user.must_change_password,
      status: session.user.status,
    },
    expiresAt: session.expires_at,
  };
}

function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Revoke one session — signing out.
 *
 * Idempotent: revoking an already-revoked or unknown session is not an error,
 * because a sign-out that fails on a double click is worse than one that does
 * nothing. Returns whether a live session was actually ended.
 */
export async function revokeSession(
  token: string | null | undefined,
  db: Db = prisma,
): Promise<boolean> {
  if (!token) return false;

  const result = await db.session.updateMany({
    where: { token_hash: hashToken(token), revoked_at: null },
    data: { revoked_at: new Date() },
  });

  return result.count > 0;
}

/**
 * Revoke every live session for a user.
 *
 * The action behind disabling an account or changing a password: an attacker
 * holding a session from before must not keep it. `resolveSession` already
 * rejects a disabled user, but a password change leaves the account active, so
 * this is the only thing that ends the old sessions.
 */
export async function revokeAllSessions(
  userId: string,
  db: Db = prisma,
): Promise<number> {
  const result = await db.session.updateMany({
    where: { user_id: userId, revoked_at: null },
    data: { revoked_at: new Date() },
  });

  return result.count;
}
