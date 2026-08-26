import { prisma, type Db } from "../db";
import {
  type EffectiveRole,
  type ScopeUser,
  canAccessClient,
  effectiveRole,
} from "./accessScope";
import { flagRoleBoundaryViolation } from "./misuse";

/**
 * One table of who may do what.
 *
 * Every route and every domain function asks the same question here rather than
 * re-deriving it. A capability re-derived in two places is a capability that
 * disagrees with itself in one of them — and the disagreement is always
 * discovered by someone doing what they should not have been able to.
 *
 * Derived from the PRD §9 role table, mirrored in `docs/architecture.md` §9. The
 * test file drives that matrix directly, so a change to the doc that is not made
 * here fails the build.
 *
 * Two things this deliberately does not do:
 *
 *   - It does not check the approval gate. `canSchedule` in `gate.ts` is a fact
 *     about the content's approval state, not about the person asking. A user
 *     with the capability still cannot schedule unapproved work.
 *   - It does not decide *which clients* someone sees — `accessScope.ts` does.
 *     This asks "may this role do this at all", then defers scope to that.
 */

/** Everything a person can attempt. Grouped by the area it belongs to. */
export const ACTIONS = [
  // Clients and onboarding
  "client.create",
  "client.edit",
  "client.assign_roles",
  "client.issue_otp",

  // Briefs and campaigns
  "campaign.submit",
  "campaign.view",
  "post_request.create",
  "post_request.convert",

  // Content production
  "content.generate",
  "content.edit_draft",
  "content.attach_reference",
  "content.regenerate",
  // Opening or appending to a conversation with the engine (Phase 14). Distinct
  // from `content.generate`: generate is the act of producing an item, chat is
  // reaching the surface that may produce one. A role can hold either alone.
  "content.chat",
  // Assigning a produced item to a creator. The lead's dispatch power.
  "task.assign",

  // Review and approval
  "approval.internal",
  "approval.client",
  "approval.revoke",

  // Publishing
  "publish.schedule",
  "publish.now",
  "publish.take_down",

  // Platform credentials
  "platform.connect",
  "platform.view_credentials",

  // Brand guides
  "brand_guide.upload",
  "brand_guide.approve",

  // Oversight
  "analytics.view",
  "audit.view",
  "flag.view_governance",
  "flag.resolve",
] as const;

export type Action = (typeof ACTIONS)[number];

/**
 * The capability matrix.
 *
 * Written as role → allowed actions rather than action → roles, because the
 * question asked at runtime is always "may *this user* do this", and because
 * reading one role's whole surface in one place is how a reviewer spots a role
 * that quietly gained too much.
 */
const CAPABILITIES: Record<EffectiveRole, ReadonlySet<Action>> = {
  account_manager: new Set<Action>([
    "client.create",
    "client.edit",
    // Staffing a client is the account manager's, as the owner of the
    // relationship. The agency admin keeps it too, as an oversight backstop --
    // see the note on `agency_admin` below.
    "client.assign_roles",
    "client.issue_otp",
    "campaign.submit",
    "campaign.view",
    "post_request.convert",
    "content.generate",
    "content.edit_draft",
    // Internal reviewer by default -- the content lead replaces them only where
    // one is assigned.
    "approval.internal",
    "approval.revoke",
    "publish.schedule",
    "publish.take_down",
    "platform.connect",
    "platform.view_credentials",
    "brand_guide.upload",
    "analytics.view",
  ]),

  content_creator: new Set<Action>([
    "campaign.view",
    "content.generate",
    "content.edit_draft",
    // The creator is the only role that attaches reference material.
    "content.attach_reference",
    "content.regenerate",
    // The creator's primary surface: content originates in conversation.
    "content.chat",
    // Staging only. Scheduling stays gate-controlled regardless of who staged
    // the work, and a creator never triggers publish directly.
    "analytics.view",
  ]),

  content_lead: new Set<Action>([
    "campaign.view",
    "content.generate",
    "content.edit_draft",
    "content.regenerate",
    // The lead prompts the engine as a creator does, and dispatches what comes
    // out of it. Still no `content.attach_reference` -- attaching reference
    // material stays the creator's alone, as it was before Phase 14.
    "content.chat",
    "task.assign",
    // Acts as internal reviewer in place of the account manager where assigned,
    // with the same late-revoke power.
    "approval.internal",
    "approval.revoke",
    "publish.schedule",
    "publish.take_down",
    "analytics.view",
  ]),

  client_contact: new Set<Action>([
    "campaign.view",
    "post_request.create",
    // Final approval on content and on brand guide changes.
    "approval.client",
    "approval.revoke",
    "brand_guide.approve",
    "analytics.view",
  ]),

  agency_admin: new Set<Action>([
    // Shared with the account manager since Phase 14, not exclusive. The admin
    // keeps it so oversight can correct a staffing mistake on a client whose
    // account manager is the one who made it.
    "client.assign_roles",
    "campaign.view",
    "analytics.view",
    "audit.view",
    "flag.view_governance",
    "flag.resolve",
    // Deliberately absent: the admin is the accountability role and is "not
    // involved in day-to-day content work". Giving them drafting or approval
    // powers would make them a participant in what they oversee.
  ]),
};

/** Actions that mean nothing without a client — every one of these is scoped. */
const CLIENT_SCOPED_ACTIONS = new Set<Action>([
  "client.edit",
  "client.assign_roles",
  "client.issue_otp",
  "campaign.submit",
  "campaign.view",
  "post_request.create",
  "post_request.convert",
  "content.generate",
  "content.edit_draft",
  "content.attach_reference",
  "content.regenerate",
  "content.chat",
  "task.assign",
  "approval.internal",
  "approval.client",
  "approval.revoke",
  "publish.schedule",
  "publish.now",
  "publish.take_down",
  "platform.connect",
  "platform.view_credentials",
  "brand_guide.upload",
  "brand_guide.approve",
  "analytics.view",
]);

export type PermissionContext = {
  /** Required for any client-scoped action. */
  clientId?: string | null;
};

export type PermissionResult =
  | { allowed: true; role: EffectiveRole }
  | { allowed: false; role: EffectiveRole; reason: DenialReason };

export type DenialReason =
  /** The role does not hold this capability at all. */
  | "role_lacks_capability"
  /** The role holds it, but not on this client. */
  | "outside_client_scope"
  /** A client-scoped action asked without naming a client. */
  | "missing_client_context"
  /** The account cannot act at all. */
  | "inactive_account";

/** Whether a role holds a capability at all, ignoring client scope. */
export function roleCan(role: EffectiveRole, action: Action): boolean {
  return CAPABILITIES[role].has(action);
}

/** Every action a role holds — for building a UI that hides what it cannot do. */
export function actionsFor(role: EffectiveRole): Action[] {
  return [...CAPABILITIES[role]].sort();
}

export function isClientScoped(action: Action): boolean {
  return CLIENT_SCOPED_ACTIONS.has(action);
}

/**
 * May this user do this?
 *
 * Two gates, in order. The capability comes first because a role that cannot do
 * something at all should be refused the same way whichever client it names —
 * checking scope first would leak, through the difference between the two
 * denials, which clients exist.
 *
 * Does not raise a flag. `enforce` does, so a caller probing what is permitted —
 * to grey out a button, say — does not fill the Admin's queue.
 */
export async function can(
  user: ScopeUser & { status?: string },
  action: Action,
  context: PermissionContext = {},
  db: Db = prisma,
): Promise<PermissionResult> {
  const role = await effectiveRole(user, db);

  if (user.status !== undefined && user.status !== "active") {
    return { allowed: false, role, reason: "inactive_account" };
  }

  if (!roleCan(role, action)) {
    return { allowed: false, role, reason: "role_lacks_capability" };
  }

  if (!isClientScoped(action)) return { allowed: true, role };

  const clientId = context.clientId;
  if (!clientId) {
    // Refused rather than assumed. A scoped action with no client named would
    // otherwise run unscoped, which is the failure this module exists to stop.
    return { allowed: false, role, reason: "missing_client_context" };
  }

  if (!(await canAccessClient(user, clientId, db))) {
    return { allowed: false, role, reason: "outside_client_scope" };
  }

  return { allowed: true, role };
}

export class PermissionDeniedError extends Error {
  readonly code = "PERMISSION_DENIED";
  readonly reason: DenialReason;
  readonly action: Action;
  readonly role: EffectiveRole;

  constructor(action: Action, role: EffectiveRole, reason: DenialReason) {
    super(`A ${role} may not ${action} (${reason}).`);
    this.name = "PermissionDeniedError";
    this.reason = reason;
    this.action = action;
    this.role = role;
  }
}

/**
 * Require a capability, or refuse and record the attempt.
 *
 * Every denial raises a `role_boundary_violation` — a rejected attempt is
 * exactly what the Admin needs to see, and refusing silently means someone
 * probing what they can reach leaves no trace at all.
 *
 * `inactive_account` and `missing_client_context` are not flagged: the first is
 * an account state rather than an attempt, and the second is a caller bug rather
 * than a user's conduct. Flagging either would fill the queue with rows naming
 * people who did nothing.
 */
export async function enforce(
  user: ScopeUser & { status?: string },
  action: Action,
  context: PermissionContext = {},
  db: Db = prisma,
): Promise<void> {
  const result = await can(user, action, context, db);
  if (result.allowed) return;

  if (result.reason === "role_lacks_capability" || result.reason === "outside_client_scope") {
    await flagRoleBoundaryViolation(
      {
        raisedAgainstId: user.user_id,
        action,
        role: result.role,
        clientId: context.clientId ?? null,
        reason: result.reason,
      },
      db,
    );
  }

  throw new PermissionDeniedError(action, result.role, result.reason);
}
