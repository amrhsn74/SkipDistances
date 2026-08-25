import { describe, it, expect, beforeEach, afterAll } from "vitest";

import { prisma } from "../db";
import {
  OTP_TTL_MINUTES,
  OtpIssueError,
  generateCode,
  issueOtp,
  redeemOtp,
} from "./otp";

/**
 * The flow under test: an account manager creates a client contact and is shown
 * a code on screen to pass on. The contact redeems it and is forced to set a
 * password before reaching anything.
 *
 * The two properties worth more than the happy path: the plaintext is never
 * persisted, and redeeming activates the account without signing anyone in.
 */

const CONTACT = "TEST-OTP-CONTACT";
const CONTACT_EMAIL = "test-otp-contact@skipstudio.test";
const MANAGER = "TEST-OTP-MANAGER";
const MANAGER_EMAIL = "test-otp-manager@skipstudio.test";

async function clearOtps() {
  await prisma.loginOtp.deleteMany({ where: { user_id: { in: [CONTACT, MANAGER] } } });
  await prisma.auditLog.deleteMany({ where: { entity_type: "LoginOtp" } });
}

beforeEach(async () => {
  await clearOtps();

  await prisma.user.upsert({
    where: { user_id: MANAGER },
    update: { status: "active" },
    create: {
      user_id: MANAGER,
      name: "Test OTP Manager",
      email: MANAGER_EMAIL,
      user_type: "staff",
    },
  });

  // The state a freshly created contact is in: invited, no password at all.
  await prisma.user.upsert({
    where: { user_id: CONTACT },
    update: {
      status: "invited",
      password_hash: null,
      must_change_password: false,
      email: CONTACT_EMAIL,
    },
    create: {
      user_id: CONTACT,
      name: "Test OTP Contact",
      email: CONTACT_EMAIL,
      user_type: "client_contact",
      status: "invited",
    },
  });
});

afterAll(async () => {
  await clearOtps();
  await prisma.user.deleteMany({ where: { user_id: { in: [CONTACT, MANAGER] } } });
});

describe("generateCode", () => {
  it("is six digits, and keeps leading zeros", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateCode()).toMatch(/^[0-9]{6}$/);
    }
  });

  it("does not repeat itself", () => {
    // Not a randomness proof -- a guard against a constant or a counter.
    const codes = new Set(Array.from({ length: 50 }, () => generateCode()));
    expect(codes.size).toBeGreaterThan(45);
  });
});

describe("issueOtp", () => {
  it("returns the plaintext once and never stores it", async () => {
    const { code, otpId } = await issueOtp({ userId: CONTACT, byAccountManagerId: MANAGER });

    const row = await prisma.loginOtp.findUniqueOrThrow({ where: { otp_id: otpId } });

    expect(row.code_hash).not.toBe(code);
    expect(row.code_hash).not.toContain(code);
    expect(row.code_hash.startsWith("scrypt$")).toBe(true);

    // Nothing anywhere in the row -- not a column added later, not the audit
    // details -- may carry the plaintext.
    expect(JSON.stringify(row)).not.toContain(code);

    const audit = await prisma.auditLog.findMany({ where: { entity_id: otpId } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(code);
    expect(audit[0].performed_by_id).toBe(MANAGER);
  });

  it("expires the code within the TTL", async () => {
    const before = Date.now();
    const { expiresAt } = await issueOtp({ userId: CONTACT });

    expect(expiresAt.getTime()).toBeGreaterThan(before);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(before + OTP_TTL_MINUTES * 60_000 + 5_000);
  });

  it("supersedes an outstanding code, so only the newest works", async () => {
    const first = await issueOtp({ userId: CONTACT });
    const second = await issueOtp({ userId: CONTACT });

    // A manager who reissues believes the old code is dead. If it still worked,
    // a code someone read over a shoulder would outlive the reissue.
    expect(await redeemOtp(CONTACT_EMAIL, first.code)).toEqual({
      ok: false,
      reason: "wrong_code",
    });
    expect((await redeemOtp(CONTACT_EMAIL, second.code)).ok).toBe(true);
  });

  it("supersedes even when both codes carry the same timestamp", async () => {
    const first = await issueOtp({ userId: CONTACT });
    const second = await issueOtp({ userId: CONTACT });

    // Force the tie SQLite's millisecond timestamps can produce when a manager
    // reissues twice in quick succession. Picking the "newest" row by
    // created_at is unspecified here; only consuming the old code on reissue
    // makes the outcome deterministic.
    const same = new Date("2026-01-01T00:00:00.000Z");
    await prisma.loginOtp.updateMany({
      where: { user_id: CONTACT },
      data: { created_at: same },
    });

    expect(await redeemOtp(CONTACT_EMAIL, first.code)).toEqual({
      ok: false,
      reason: "wrong_code",
    });
    expect((await redeemOtp(CONTACT_EMAIL, second.code)).ok).toBe(true);
  });

  it("refuses an unknown or disabled user", async () => {
    await expect(issueOtp({ userId: "NO-SUCH-USER" })).rejects.toThrow(OtpIssueError);

    await prisma.user.update({ where: { user_id: CONTACT }, data: { status: "disabled" } });
    await expect(issueOtp({ userId: CONTACT })).rejects.toMatchObject({
      reason: "not_invitable",
    });
  });
});

describe("redeemOtp", () => {
  it("activates the account and forces a password change", async () => {
    const { code } = await issueOtp({ userId: CONTACT, byAccountManagerId: MANAGER });

    const result = await redeemOtp(CONTACT_EMAIL, code);
    expect(result).toEqual({ ok: true, userId: CONTACT, mustChangePassword: true });

    const user = await prisma.user.findUniqueOrThrow({ where: { user_id: CONTACT } });
    expect(user.status).toBe("active");
    expect(user.must_change_password).toBe(true);
  });

  it("grants no session", async () => {
    const { code } = await issueOtp({ userId: CONTACT });
    await redeemOtp(CONTACT_EMAIL, code);

    // Redeeming proves someone holds a code that was shown on a screen. That is
    // not yet proof of identity -- the session comes after they set a password.
    expect(await prisma.session.count({ where: { user_id: CONTACT } })).toBe(0);

    const user = await prisma.user.findUniqueOrThrow({ where: { user_id: CONTACT } });
    expect(user.password_hash).toBeNull();
    expect(user.last_login_at).toBeNull();
  });

  it("works exactly once", async () => {
    const { code } = await issueOtp({ userId: CONTACT });

    expect((await redeemOtp(CONTACT_EMAIL, code)).ok).toBe(true);
    expect(await redeemOtp(CONTACT_EMAIL, code)).toEqual({
      ok: false,
      reason: "already_used",
    });
  });

  it("rejects a wrong code without consuming the real one", async () => {
    const { code } = await issueOtp({ userId: CONTACT });
    const wrong = code === "000000" ? "111111" : "000000";

    expect(await redeemOtp(CONTACT_EMAIL, wrong)).toEqual({
      ok: false,
      reason: "wrong_code",
    });

    // A failed guess must not burn the code -- otherwise one wrong digit from
    // anyone locks the real contact out.
    expect((await redeemOtp(CONTACT_EMAIL, code)).ok).toBe(true);
  });

  it("rejects an expired code, and leaves the account invited", async () => {
    const { code, otpId } = await issueOtp({ userId: CONTACT });
    await prisma.loginOtp.update({
      where: { otp_id: otpId },
      data: { expires_at: new Date(Date.now() - 1_000) },
    });

    expect(await redeemOtp(CONTACT_EMAIL, code)).toEqual({ ok: false, reason: "expired" });

    const user = await prisma.user.findUniqueOrThrow({ where: { user_id: CONTACT } });
    expect(user.status).toBe("invited");
    expect(user.must_change_password).toBe(false);
  });

  it("rejects an unknown email and a user with no code issued", async () => {
    expect(await redeemOtp("nobody@skipstudio.test", "123456")).toEqual({
      ok: false,
      reason: "unknown_user",
    });
    expect(await redeemOtp(CONTACT_EMAIL, "123456")).toEqual({
      ok: false,
      reason: "no_code_issued",
    });
  });

  it("matches the email case-insensitively", async () => {
    const { code } = await issueOtp({ userId: CONTACT });

    // Emails are stored lowercased; a contact typing their address with a
    // capital must not be told their code is wrong.
    expect((await redeemOtp(`  ${CONTACT_EMAIL.toUpperCase()}  `, code)).ok).toBe(true);
  });

  it("refuses a disabled user holding a valid code", async () => {
    const { code } = await issueOtp({ userId: CONTACT });
    await prisma.user.update({ where: { user_id: CONTACT }, data: { status: "disabled" } });

    expect(await redeemOtp(CONTACT_EMAIL, code)).toEqual({
      ok: false,
      reason: "not_invitable",
    });
  });
});
