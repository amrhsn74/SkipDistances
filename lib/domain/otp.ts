import { randomInt } from "node:crypto";

import { prisma, type Db } from "../db";
import { writeAudit } from "./auditLog";
import { hashWithoutPolicy, verifyPassword } from "./password";

/**
 * One-time codes for client-contact activation.
 *
 * The PRD's onboarding flow: an account manager creates the contact and is shown
 * a code **on screen** to pass on out of band. The contact signs in with their
 * email and that code, and is then forced to choose their own password before
 * reaching anything.
 *
 * Two properties this module exists to guarantee:
 *
 *   1. The plaintext code is returned exactly once, at issue, and is never
 *      persisted. A leaked `LoginOtp` table hands over no working codes — it is
 *      hashed with the same KDF as a password, because that is exactly what it
 *      is while it lives.
 *   2. Redeeming does not sign anyone in. It marks the account activated and
 *      `must_change_password`; the session comes later, after the password is
 *      set. Conflating the two would leave a working session belonging to a
 *      person holding a code someone else could have read over their shoulder.
 */

/**
 * Six digits. Short enough to read aloud or type from a screen, which is the
 * actual delivery channel here. The brute-force budget is controlled by the
 * short expiry and by single-use, not by the code's length.
 */
const CODE_LENGTH = 6;

export const OTP_TTL_MINUTES = 30;

/** Why a redemption failed. Never surfaced to the user verbatim — see below. */
export type OtpFailure =
  | "unknown_user"
  | "no_code_issued"
  | "expired"
  | "already_used"
  | "wrong_code"
  | "not_invitable";

export type RedeemResult =
  | { ok: true; userId: string; mustChangePassword: true }
  | { ok: false; reason: OtpFailure };

export class OtpIssueError extends Error {
  readonly code = "OTP_ISSUE";
  readonly reason: OtpFailure;
  constructor(reason: OtpFailure, message: string) {
    super(message);
    this.name = "OtpIssueError";
    this.reason = reason;
  }
}

/**
 * A uniformly random numeric code.
 *
 * `randomInt` from node:crypto, not `Math.random()`: a predictable code is the
 * same as no code. Leading zeros are preserved by padding, so every code in the
 * range is equally likely rather than 0–99999 being silently shortened.
 */
export function generateCode(): string {
  const max = 10 ** CODE_LENGTH;
  return String(randomInt(0, max)).padStart(CODE_LENGTH, "0");
}

export type IssueOtpInput = {
  userId: string;
  /** The account manager issuing it, for the audit trail. */
  byAccountManagerId?: string | null;
  ttlMinutes?: number;
};

export type IssuedOtp = {
  otpId: string;
  /** The plaintext, returned once. Display it; do not store it. */
  code: string;
  expiresAt: Date;
};

/**
 * Issue a one-time code for a user.
 *
 * Any code that user is still holding is consumed first. Two live codes would
 * mean an older one, possibly already seen by someone else, still works after
 * the account manager reissued precisely because they thought it was stale.
 */
export async function issueOtp(input: IssueOtpInput, db: Db = prisma): Promise<IssuedOtp> {
  const { userId, byAccountManagerId = null, ttlMinutes = OTP_TTL_MINUTES } = input;

  const user = await db.user.findUnique({ where: { user_id: userId } });
  if (!user) {
    throw new OtpIssueError("unknown_user", `No user ${userId}.`);
  }
  if (user.status === "disabled") {
    throw new OtpIssueError(
      "not_invitable",
      `User ${userId} is disabled; re-enable the account before issuing a code.`,
    );
  }

  const code = generateCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000);

  // Supersede anything outstanding, so exactly one code is ever live.
  await db.loginOtp.updateMany({
    where: { user_id: userId, consumed_at: null },
    data: { consumed_at: now },
  });

  const created = await db.loginOtp.create({
    data: {
      user_id: userId,
      code_hash: await hashWithoutPolicy(code),
      expires_at: expiresAt,
      created_by_id: byAccountManagerId,
    },
  });

  await writeAudit(
    {
      entityType: "LoginOtp",
      entityId: created.otp_id,
      action: "created",
      performedById: byAccountManagerId,
      // Deliberately no code, and no hash. The trail records that a code was
      // issued, to whom, and by whom -- never anything that helps use it.
      details: { user_id: userId, expires_at: expiresAt.toISOString() },
    },
    db,
  );

  return { otpId: created.otp_id, code, expiresAt };
}

/**
 * Redeem a code.
 *
 * On success the account becomes `active` with `must_change_password` set, and
 * the code is consumed. It grants no session: the caller must take the user
 * through setting a password first.
 *
 * The `reason` is for the audit trail and for tests. A sign-in screen should
 * show one message for every failure — distinguishing "no such user" from
 * "wrong code" tells an attacker which emails exist.
 */
export async function redeemOtp(
  email: string,
  code: string,
  db: Db = prisma,
): Promise<RedeemResult> {
  const user = await db.user.findUnique({
    where: { email: email.trim().toLowerCase() },
  });
  if (!user) return { ok: false, reason: "unknown_user" };
  if (user.status === "disabled") return { ok: false, reason: "not_invitable" };

  // Exactly one code is ever unconsumed -- `issueOtp` consumes the previous one
  // before creating a new one. So the live code is found by `consumed_at: null`
  // rather than by taking the newest row, which would tie on SQLite's
  // millisecond timestamps when a manager reissues twice in quick succession.
  const live = await db.loginOtp.findFirst({
    where: { user_id: user.user_id, consumed_at: null },
  });

  if (!live) {
    const everIssued = await db.loginOtp.count({ where: { user_id: user.user_id } });
    return { ok: false, reason: everIssued === 0 ? "no_code_issued" : "already_used" };
  }

  const now = new Date();
  const candidate = live;
  if (candidate.expires_at.getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }

  const matches = await verifyPassword(code.trim(), candidate.code_hash);
  if (!matches) return { ok: false, reason: "wrong_code" };

  await db.loginOtp.update({
    where: { otp_id: candidate.otp_id },
    data: { consumed_at: now },
  });

  await db.user.update({
    where: { user_id: user.user_id },
    data: { status: "active", must_change_password: true },
  });

  await writeAudit(
    {
      entityType: "LoginOtp",
      entityId: candidate.otp_id,
      action: "edited",
      performedById: user.user_id,
      details: { redeemed: true, user_id: user.user_id },
    },
    db,
  );

  return { ok: true, userId: user.user_id, mustChangePassword: true };
}
