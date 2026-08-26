import { describe, it, expect, beforeEach, afterAll } from "vitest";

import { prisma } from "../db";
import type { EffectiveRole, ScopeUser } from "./accessScope";
import {
  ACTIONS,
  type Action,
  PermissionDeniedError,
  actionsFor,
  can,
  enforce,
  isClientScoped,
  roleCan,
} from "./permissions";

/**
 * Driven against the capability matrix in `docs/architecture.md` §9 and the
 * seeded roster. The matrix below is transcribed from that table; if the doc
 * and the code drift apart, these fail.
 *
 * The denials matter more than the grants. A permission module that says yes to
 * the right people but does not say no to the wrong ones is not doing its job.
 */

async function userByEmail(email: string): Promise<ScopeUser & { status: string }> {
  return prisma.user.findUniqueOrThrow({
    where: { email },
    select: { user_id: true, user_type: true, is_agency_admin: true, status: true },
  });
}

let admin: ScopeUser & { status: string };
let lead: ScopeUser & { status: string };
let creator: ScopeUser & { status: string };
let accountManager: ScopeUser & { status: string };
let contact: ScopeUser & { status: string };

/** A client each role may reach, so a grant is not refused on scope. */
let amClient = "";
let creatorClient = "";
const CONTACT_CLIENT = "CL-101";

async function clearFlags() {
  await prisma.auditLog.deleteMany({ where: { entity_type: "Flag" } });
  await prisma.flag.deleteMany({});
}

beforeEach(async () => {
  await clearFlags();

  admin = await userByEmail("hala.mansour@skipstudio.test");
  lead = await userByEmail("youssef.adel@skipstudio.test");
  creator = await userByEmail("mona.farid@skipstudio.test");
  contact = await userByEmail("rana.fouad@skipstudio.test");

  const managed = await prisma.client.findFirstOrThrow({
    where: { NOT: { account_manager_id: null } },
    select: { client_id: true, account_manager_id: true },
    orderBy: { client_id: "asc" },
  });
  amClient = managed.client_id;
  accountManager = await prisma.user.findUniqueOrThrow({
    where: { user_id: managed.account_manager_id! },
    select: { user_id: true, user_type: true, is_agency_admin: true, status: true },
  });

  const creatorAssignment = await prisma.clientAssignment.findFirstOrThrow({
    where: { user_id: creator.user_id },
    select: { client_id: true },
  });
  creatorClient = creatorAssignment.client_id;
});

afterAll(async () => {
  await clearFlags();
});

describe("the action vocabulary", () => {
  it("has no duplicates", () => {
    expect(new Set(ACTIONS).size).toBe(ACTIONS.length);
  });

  it("grants publish.now to nobody", () => {
    // Publishing is gate-controlled and happens through the scheduler. No role
    // triggers it directly -- the capability exists so a route asking for it is
    // refused rather than finding no rule at all.
    const roles: EffectiveRole[] = [
      "account_manager", "content_creator", "content_lead", "client_contact", "agency_admin",
    ];
    for (const r of roles) expect(roleCan(r, "publish.now"), r).toBe(false);
  });

  it("scopes every action that names a client", () => {
    // The unscoped set is the whole exception list, written out so adding an
    // action without deciding its scope is visible here.
    const unscoped = ACTIONS.filter((a) => !isClientScoped(a));
    expect([...unscoped].sort()).toEqual([
      "audit.view",
      "client.create",
      "flag.resolve",
      "flag.view_governance",
    ]);
  });
});

describe("the capability matrix, per docs/architecture.md §9", () => {
  const GRANTS: Record<EffectiveRole, Action[]> = {
    account_manager: [
      "client.create", "client.edit", "client.issue_otp", "campaign.submit",
      "post_request.convert", "approval.internal", "approval.revoke",
      "publish.schedule", "platform.connect", "platform.view_credentials",
      "brand_guide.upload",
      // Phase 14: the owner of the relationship staffs it.
      "client.assign_roles",
    ],
    content_creator: [
      "content.generate", "content.edit_draft", "content.attach_reference",
      "content.regenerate", "campaign.view",
      // Phase 14: content originates in conversation.
      "content.chat",
    ],
    content_lead: [
      "approval.internal", "approval.revoke", "publish.schedule",
      "content.regenerate", "campaign.view",
      // Phase 14: the lead prompts the engine and dispatches the result.
      "content.chat", "task.assign",
    ],
    client_contact: [
      "post_request.create", "approval.client", "approval.revoke",
      "brand_guide.approve", "analytics.view",
    ],
    agency_admin: [
      "client.assign_roles", "audit.view", "flag.view_governance", "flag.resolve",
    ],
  };

  const DENIALS: Record<EffectiveRole, Action[]> = {
    // The account manager is not the client, and does not give client approval.
    account_manager: ["approval.client", "audit.view", "publish.now"],
    // Staging only: a creator never schedules, publishes, approves, or connects
    // a platform account.
    content_creator: [
      "publish.schedule", "publish.now", "approval.internal", "approval.client",
      "platform.connect", "client.create", "client.assign_roles",
      // A creator works the items they hold; dispatching them is the lead's.
      "task.assign",
    ],
    // A lead reviews; they do not attach references or hold client approval.
    content_lead: ["approval.client", "content.attach_reference", "client.assign_roles"],
    // A client contact never reaches production, credentials, or the audit trail.
    client_contact: [
      "content.generate", "content.edit_draft", "content.attach_reference",
      "approval.internal", "publish.schedule", "platform.connect",
      "platform.view_credentials", "campaign.submit", "audit.view",
      // The engine is a staff surface. A client asks for a post; they do not
      // prompt for one.
      "content.chat", "task.assign",
    ],
    // The accountability role is "not involved in day-to-day content work" --
    // giving it drafting or approval powers would make it a participant in what
    // it oversees.
    agency_admin: [
      "content.generate", "content.edit_draft", "approval.internal",
      "approval.client", "publish.schedule", "campaign.submit", "client.create",
      // Phase 14 changes nothing here: the accountability role still does no
      // content work, so it neither chats nor dispatches.
      "content.chat", "task.assign",
    ],
  };

  for (const role of Object.keys(GRANTS) as EffectiveRole[]) {
    it(`grants ${role} exactly what the table says`, () => {
      for (const action of GRANTS[role]) {
        expect(roleCan(role, action), `${role} should hold ${action}`).toBe(true);
      }
      for (const action of DENIALS[role]) {
        expect(roleCan(role, action), `${role} must not hold ${action}`).toBe(false);
      }
    });
  }

  it("gives no role every capability", () => {
    for (const role of Object.keys(GRANTS) as EffectiveRole[]) {
      expect(actionsFor(role).length).toBeLessThan(ACTIONS.length);
    }
  });
});

describe("can", () => {
  it("allows a role acting within its scope", async () => {
    expect(await can(accountManager, "campaign.submit", { clientId: amClient })).toMatchObject({
      allowed: true,
      role: "account_manager",
    });
    expect(await can(creator, "content.generate", { clientId: creatorClient })).toMatchObject({
      allowed: true,
    });
    expect(await can(contact, "approval.client", { clientId: CONTACT_CLIENT })).toMatchObject({
      allowed: true,
    });
    expect(await can(admin, "audit.view")).toMatchObject({ allowed: true });
  });

  it("refuses an account manager on a client they do not manage", async () => {
    const other = await prisma.client.findFirstOrThrow({
      where: { NOT: { account_manager_id: accountManager.user_id } },
      select: { client_id: true },
    });

    expect(await can(accountManager, "campaign.submit", { clientId: other.client_id })).toMatchObject({
      allowed: false,
      reason: "outside_client_scope",
    });
  });

  it("refuses a creator on a client they are not assigned to", async () => {
    const unassigned = await prisma.client.findFirstOrThrow({
      where: { assignments: { none: { user_id: creator.user_id } } },
      select: { client_id: true },
    });

    expect(await can(creator, "content.generate", { clientId: unassigned.client_id })).toMatchObject({
      allowed: false,
      reason: "outside_client_scope",
    });
  });

  it("refuses a client contact reaching another client", async () => {
    expect(await can(contact, "approval.client", { clientId: "CL-102" })).toMatchObject({
      allowed: false,
      reason: "outside_client_scope",
    });
  });

  it("checks the capability before the scope", async () => {
    // A role that cannot do something at all is refused the same way whichever
    // client it names. Checking scope first would leak, through the difference
    // between the two denials, which clients exist.
    const result = await can(creator, "platform.connect", { clientId: "CL-999-NOT-REAL" });

    expect(result).toMatchObject({ allowed: false, reason: "role_lacks_capability" });
  });

  it("refuses a scoped action with no client named", async () => {
    // Running unscoped is the failure this module exists to stop, so a missing
    // client is a denial rather than an assumption.
    expect(await can(accountManager, "campaign.submit")).toMatchObject({
      allowed: false,
      reason: "missing_client_context",
    });
  });

  it("refuses an inactive account whatever its role", async () => {
    expect(
      await can({ ...admin, status: "disabled" }, "audit.view"),
    ).toMatchObject({ allowed: false, reason: "inactive_account" });

    expect(
      await can({ ...contact, status: "invited" }, "approval.client", { clientId: CONTACT_CLIENT }),
    ).toMatchObject({ allowed: false, reason: "inactive_account" });
  });

  it("lets a content lead act across clients they hold no assignment on", async () => {
    // The lead's cross-client visibility is deliberate; the CL-103 assignment
    // makes them internal reviewer there, and does not narrow the rest.
    expect(await can(lead, "approval.internal", { clientId: "CL-101" })).toMatchObject({
      allowed: true,
      role: "content_lead",
    });
  });

  it("raises no flag -- probing what is permitted must not fill the queue", async () => {
    await can(creator, "publish.schedule", { clientId: creatorClient });
    await can(contact, "audit.view");

    expect(await prisma.flag.count()).toBe(0);
  });
});

describe("enforce", () => {
  it("passes silently when allowed", async () => {
    await expect(
      enforce(accountManager, "campaign.submit", { clientId: amClient }),
    ).resolves.toBeUndefined();

    expect(await prisma.flag.count()).toBe(0);
  });

  it("throws and flags when the role lacks the capability", async () => {
    await expect(
      enforce(creator, "publish.schedule", { clientId: creatorClient }),
    ).rejects.toThrow(PermissionDeniedError);

    const flags = await prisma.flag.findMany();
    expect(flags).toHaveLength(1);
    expect(flags[0].flag_type).toBe("role_boundary_violation");
    expect(flags[0].severity).toBe("high");
    expect(flags[0].raised_against_id).toBe(creator.user_id);

    const details = JSON.parse(flags[0].details!);
    expect(details.action).toBe("publish.schedule");
    expect(details.role).toBe("content_creator");
    expect(details.reason).toBe("role_lacks_capability");
  });

  it("throws and flags when the role reaches another client", async () => {
    await expect(
      enforce(contact, "approval.client", { clientId: "CL-102" }),
    ).rejects.toThrow(PermissionDeniedError);

    const flags = await prisma.flag.findMany();
    expect(flags).toHaveLength(1);
    expect(JSON.parse(flags[0].details!)).toMatchObject({
      reason: "outside_client_scope",
      client_id: "CL-102",
    });
  });

  it("does not flag an inactive account or a missing client", async () => {
    // Neither is conduct: one is an account state, the other a caller bug.
    // Flagging either fills the Admin's queue with people who did nothing.
    await expect(
      enforce({ ...contact, status: "disabled" }, "approval.client", { clientId: CONTACT_CLIENT }),
    ).rejects.toThrow(PermissionDeniedError);

    await expect(enforce(accountManager, "campaign.submit")).rejects.toThrow(
      PermissionDeniedError,
    );

    expect(await prisma.flag.count()).toBe(0);
  });

  it("carries the reason on the error, for the route to render", async () => {
    try {
      await enforce(creator, "approval.internal", { clientId: creatorClient });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as PermissionDeniedError;
      expect(err.reason).toBe("role_lacks_capability");
      expect(err.action).toBe("approval.internal");
      expect(err.role).toBe("content_creator");
    }
  });
});
