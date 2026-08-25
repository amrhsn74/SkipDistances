import { cookies } from "next/headers";

import { prisma, type Db } from "../db";
import { resolveSession, type ResolvedSession } from "../domain/session";

/**
 * What every route handler does before it does anything else: work out who is
 * asking.
 *
 * The acting user comes from the session cookie and nothing else. Not a query
 * parameter, not a header, not a body field -- a request that carried its own
 * user id would be asking to be trusted about the very thing being checked, and
 * the PRD's isolation guarantee would then be one forged field away from
 * failing.
 *
 * Phase 5 adds the middleware that redirects a browser to sign-in. This is the
 * API-side half: a route with no valid session answers 401 rather than
 * redirecting, because its caller is fetch, not a person.
 */

/** The cookie the sign-in route sets. Named once, here. */
export const SESSION_COOKIE = "skipstudio_session";

/** The shape `accessScope` and `permissions` expect, plus the status they check. */
export type ActingUser = ResolvedSession["user"];

/**
 * The signed-in user, or null.
 *
 * `resolveSession` re-reads the user row on every call, so a disabled account
 * stops resolving on its next request rather than at the session's expiry.
 */
export async function currentUser(db: Db = prisma): Promise<ActingUser | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  const session = await resolveSession(token, db);
  return session?.user ?? null;
}

export class UnauthenticatedError extends Error {
  readonly code = "UNAUTHENTICATED";
  constructor() {
    super("Sign in to continue.");
    this.name = "UnauthenticatedError";
  }
}

export class PasswordChangeRequiredError extends Error {
  readonly code = "PASSWORD_CHANGE_REQUIRED";
  constructor() {
    super("Set your own password before continuing.");
    this.name = "PasswordChangeRequiredError";
  }
}

/**
 * The signed-in user, or throw.
 *
 * Also refuses a user still carrying `must_change_password`: a contact who has
 * redeemed a one-time code has proved they hold the code, not that they have an
 * account of their own yet. Letting them reach content on the code alone would
 * make the forced password step advisory, and the code is passed over whatever
 * channel the account manager already uses with that client.
 */
export async function requireUser(db: Db = prisma): Promise<ActingUser> {
  const user = await currentUser(db);
  if (!user) throw new UnauthenticatedError();
  if (user.must_change_password) throw new PasswordChangeRequiredError();
  return user;
}
