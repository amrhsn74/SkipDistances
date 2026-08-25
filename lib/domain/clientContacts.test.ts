import { describe, it, expect, afterEach } from "vitest";

import { prisma } from "../db";
import {
  SingleClientApproverError,
  assignClientApprover,
} from "./clientContactInvariant";
import {
  ClientContactError,
  createClientContact,
  listClientContacts,
  reissueContactCode,
} from "./clientContacts";
import { redeemOtp } from "./otp";

/**
 * Onboarding a client contact.
 *
 * Asserted against the seeded roster rather than fixtures: CL-101 is a real
 * active client and CL-102 is Cairo Roast, so the single-approver invariant is
 * exercised against data that cannot drift from itself.
 */

const CLIENT = "CL-101";
const OTHER_CLIENT = "CL-102";

/** Every address this file creates. Cleanup keys on these, not on captured ids. */
const TEST_EMAILS = [
  "contact.probe@skipstudio.test",
  "contact.second@skipstudio.test",
  "CONTACT.Upper@skipstudio.test".toLowerCase(),
];

/**
 * A test that asserts a creation is *refused* has no id to record, and a broken
 * guard would leave the row behind to desync every later test. Cleaning by
 * address means a broken guard fails its own test and nothing else.
 */
afterEach(async () => {
  const strays = await prisma.user.findMany({
    where: { email: { in: TEST_EMAILS } },
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

  await prisma.auditLog.deleteMany({ where: { entity_type: "LoginOtp" } });
});

/** Any real account manager. The audit trail has to name somebody who exists. */
async function anAccountManager() {
  const client = await prisma.client.findFirstOrThrow({
    where: { NOT: { account_manager_id: null } },
    select: { account_manager_id: true },
  });
  return client.account_manager_id!;
}

describe("createClientContact", () => {
  it("creates an invited contact with no password and a live code", async () => {
    const by = await anAccountManager();

    const { user, otp } = await createClientContact(
      { clientId: CLIENT, name: "Probe Contact", email: "contact.probe@skipstudio.test" },
      by,
    );

    expect(user.status).toBe("invited");
    expect(otp.code).toMatch(/^\d{6}$/);

    const row = await prisma.user.findUniqueOrThrow({ where: { user_id: user.user_id } });
    // No password at all. An invited contact holds a code, not a credential --
    // seeding one with a password would make the OTP step skippable.
    expect(row.password_hash).toBeNull();
    expect(row.user_type).toBe("client_contact");
  });

  it("makes the contact the approver for exactly that client", async () => {
    const by = await anAccountManager();

    const { user } = await createClientContact(
      { clientId: CLIENT, name: "Probe Contact", email: "contact.probe@skipstudio.test" },
      by,
    );

    const assignments = await prisma.clientAssignment.findMany({
      where: { user_id: user.user_id },
    });

    expect(assignments).toHaveLength(1);
    expect(assignments[0].client_id).toBe(CLIENT);
    expect(assignments[0].role_on_client).toBe("client_approver");
  });

  it("issues a code that actually redeems", async () => {
    const by = await anAccountManager();

    const { otp } = await createClientContact(
      { clientId: CLIENT, name: "Probe Contact", email: "contact.probe@skipstudio.test" },
      by,
    );

    const result = await redeemOtp("contact.probe@skipstudio.test", otp.code);

    expect(result.ok).toBe(true);
    // Redemption activates the account but leaves it unusable until a password
    // is set. That flag is what keeps a code-holder off every other screen.
    if (result.ok) expect(result.mustChangePassword).toBe(true);
  });

  it("lowercases the email, so sign-in matches whatever case was typed", async () => {
    const by = await anAccountManager();

    const { user } = await createClientContact(
      { clientId: CLIENT, name: "Probe Contact", email: "CONTACT.Upper@skipstudio.test" },
      by,
    );

    expect(user.email).toBe("contact.upper@skipstudio.test");
  });

  it("refuses an email that already belongs to somebody", async () => {
    const by = await anAccountManager();

    await expect(
      createClientContact(
        { clientId: CLIENT, name: "Impostor", email: "rana.fouad@skipstudio.test" },
        by,
      ),
    ).rejects.toBeInstanceOf(ClientContactError);
  });

  it("refuses an unknown client rather than creating an orphan account", async () => {
    const by = await anAccountManager();

    await expect(
      createClientContact(
        { clientId: "CL-DOES-NOT-EXIST", name: "Probe", email: "contact.probe@skipstudio.test" },
        by,
      ),
    ).rejects.toBeInstanceOf(ClientContactError);

    // And nothing was left behind.
    const stray = await prisma.user.findUnique({
      where: { email: "contact.probe@skipstudio.test" },
    });
    expect(stray).toBeNull();
  });

  it("names the missing field", async () => {
    const by = await anAccountManager();

    await expect(
      createClientContact({ clientId: CLIENT, name: "", email: "" }, by),
    ).rejects.toMatchObject({ issues: { name: expect.any(String), email: expect.any(String) } });
  });

  /**
   * The invariant that makes the isolation guarantee demonstrable: one person
   * approves for one client. A contact re-used across two clients would see both.
   *
   * Guarded twice over, which is the point of asserting both here. The domain
   * path raises a named error a caller can act on; the schema's unique index on
   * `user_id` refuses the row even if some future code forgets to ask. A test
   * that only covered the first would pass while the second silently lapsed.
   */
  it("refuses to make an existing approver the approver for a second client", async () => {
    const by = await anAccountManager();

    const { user } = await createClientContact(
      { clientId: CLIENT, name: "Probe Contact", email: "contact.probe@skipstudio.test" },
      by,
    );

    await expect(
      assignClientApprover({ clientId: OTHER_CLIENT, userId: user.user_id }),
    ).rejects.toBeInstanceOf(SingleClientApproverError);

    // And the database refuses it too, without going through the domain at all.
    await expect(
      prisma.clientAssignment.create({
        data: {
          client_id: OTHER_CLIENT,
          user_id: user.user_id,
          role_on_client: "client_approver",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("reissueContactCode", () => {
  /**
   * The reason re-issuing consumes the old code. A manager who re-reads a code
   * because the first did not arrive must not leave the first one working --
   * they believe they have replaced it.
   */
  it("supersedes the previous code", async () => {
    const by = await anAccountManager();

    const { user, otp: first } = await createClientContact(
      { clientId: CLIENT, name: "Probe Contact", email: "contact.probe@skipstudio.test" },
      by,
    );

    const second = await reissueContactCode(user.user_id, by);
    expect(second.code).not.toBe(first.code);

    const stale = await redeemOtp("contact.probe@skipstudio.test", first.code);
    expect(stale.ok).toBe(false);

    const fresh = await redeemOtp("contact.probe@skipstudio.test", second.code);
    expect(fresh.ok).toBe(true);
  });
});

describe("listClientContacts", () => {
  it("lists a client's approver and never another client's", async () => {
    const by = await anAccountManager();

    await createClientContact(
      { clientId: CLIENT, name: "Probe Contact", email: "contact.probe@skipstudio.test" },
      by,
    );

    const here = await listClientContacts(CLIENT);
    const elsewhere = await listClientContacts(OTHER_CLIENT);

    expect(here.map((u) => u.email)).toContain("contact.probe@skipstudio.test");
    expect(elsewhere.map((u) => u.email)).not.toContain("contact.probe@skipstudio.test");
  });
});
