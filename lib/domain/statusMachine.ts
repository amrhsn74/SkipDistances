/**
 * The `ContentItem.status` transition table.
 *
 * Every status change in the product goes through here. The one rule that
 * shapes it: **any invalidation resets to `drafted`** — a content edit, a
 * `scheduled_date` change, or a late decline from either party, all identical.
 * One rule, no per-cause branching (architecture §5).
 *
 * The reset target is `drafted` rather than `pending_internal_review` because a
 * declined item goes back to whoever is working on it to be fixed, and re-enters
 * review only when someone deliberately resubmits it. Both stages then clear
 * again from the start — an item that was `client_approved` keeps nothing.
 *
 * This file holds no database access on purpose: it is a pure function of
 * (status, cause). What the gate reads and what the scheduler does with the
 * result live elsewhere.
 */

export const CONTENT_STATUSES = [
  "drafted",
  "in_refinement",
  "pending_internal_review",
  "internal_approved",
  "pending_client_review",
  "client_approved",
  "scheduled",
  "declined",
  "flagged",
  "publishing",
  "published",
  "publish_failed",
] as const;

export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/** The two review stages an Approval row can belong to. */
export type ApprovalStage = "internal" | "client";

/**
 * What happened. `decline`, `content_edit` and `scheduled_date_change` are the
 * three invalidations, and they are deliberately interchangeable in effect.
 */
export type TransitionCause =
  | "submit_for_review"
  | "start_refinement"
  | "approve"
  | "decline"
  | "content_edit"
  | "scheduled_date_change"
  | "schedule"
  | "publish_started"
  | "publish_succeeded"
  | "publish_failed"
  | "retry_publish"
  | "flag"
  | "resolve_flag";

/** Once here, an item is live or going live: decline no longer applies. */
export const TERMINAL_FOR_DECLINE: readonly ContentStatus[] = ["publishing", "published"];

/** Statuses at which a decline (including a late revoke) is accepted. */
const DECLINABLE: readonly ContentStatus[] = [
  "pending_internal_review",
  "internal_approved",
  "pending_client_review",
  "client_approved",
  "scheduled",
];

/**
 * Statuses at which an approval already exists, so an edit invalidates it.
 * Editing a draft that nobody has approved is just editing a draft.
 */
const RESETS_ON_EDIT: readonly ContentStatus[] = [
  "internal_approved",
  "pending_client_review",
  "client_approved",
  "scheduled",
];

/**
 * The legal transition table. A target absent from a status's list cannot be
 * reached from it, whatever the cause.
 */
const TRANSITIONS: Record<ContentStatus, readonly ContentStatus[]> = {
  drafted: ["in_refinement", "pending_internal_review", "flagged"],
  in_refinement: ["drafted", "pending_internal_review", "flagged"],
  pending_internal_review: ["internal_approved", "drafted", "flagged"],
  internal_approved: ["pending_client_review", "drafted", "flagged"],
  pending_client_review: ["client_approved", "drafted", "flagged"],
  client_approved: ["scheduled", "drafted", "flagged"],
  scheduled: ["publishing", "drafted", "flagged"],
  publishing: ["published", "publish_failed"],
  // Terminal. A live post is removed by a separate staff-only take-down action,
  // never by a status change through here.
  published: [],
  publish_failed: ["scheduled", "drafted"],
  declined: ["drafted"],
  flagged: ["drafted"],
};

export function legalNextStatuses(from: ContentStatus): readonly ContentStatus[] {
  return TRANSITIONS[from] ?? [];
}

export function isLegalTransition(from: ContentStatus, to: ContentStatus): boolean {
  return legalNextStatuses(from).includes(to);
}

/** Whether a decline is accepted here. False once publishing or published. */
export function canDecline(status: ContentStatus): boolean {
  return DECLINABLE.includes(status);
}

/** Whether content or the scheduled date may be edited here. */
export function canEdit(status: ContentStatus): boolean {
  return !TERMINAL_FOR_DECLINE.includes(status);
}

/**
 * The reset an invalidation produces, or null when this cause does not
 * invalidate anything at this status.
 *
 * All three invalidating causes return the same thing by construction — that is
 * the "one rule, no per-cause branching" commitment, not a coincidence.
 */
export function resetFor(status: ContentStatus, cause: TransitionCause): ContentStatus | null {
  if (cause === "decline") {
    return canDecline(status) ? "drafted" : null;
  }

  if (cause === "content_edit" || cause === "scheduled_date_change") {
    if (!canEdit(status)) return null;
    return RESETS_ON_EDIT.includes(status) ? "drafted" : null;
  }

  return null;
}

export type TransitionInput = {
  cause: TransitionCause;
  /** Which stage acted, for a decline. Recorded, but never changes the result:
   *  a reviewer late-revoke and a client late-revoke reset identically. */
  stage?: ApprovalStage;
};

export type TransitionResult = {
  ok: boolean;
  /** The resulting status, or the unchanged input status when refused. */
  status: ContentStatus;
  /** True when the item held a scheduled slot that must be released. */
  unschedule: boolean;
  /** Why it was refused. Present only when ok is false. */
  reason?: string;
};

const refuse = (status: ContentStatus, reason: string): TransitionResult => ({
  ok: false,
  status,
  unschedule: false,
  reason,
});

/**
 * Apply a cause to a status. Pure: returns what the new status would be and
 * whether a scheduled slot needs releasing; writes nothing.
 */
export function applyTransition(
  status: ContentStatus,
  input: TransitionInput,
): TransitionResult {
  const { cause } = input;

  // A Comment is a discussion thread, not a decision. There is deliberately no
  // cause that expresses it, so it cannot move an item even by mistake.
  if (!isKnownCause(cause)) {
    return refuse(status, `"${cause}" is not a transition cause — comments never change status.`);
  }

  // Invalidations first: they are the rule with the widest reach.
  const reset = resetFor(status, cause);
  if (reset) {
    return {
      ok: true,
      status: reset,
      unschedule: status === "scheduled",
    };
  }

  if (cause === "decline") {
    return refuse(
      status,
      TERMINAL_FOR_DECLINE.includes(status)
        ? `Cannot decline an item that is ${status} — a live post needs a staff-only take-down action, not a retroactive decline.`
        : `Cannot decline an item that is ${status}.`,
    );
  }

  if (cause === "content_edit" || cause === "scheduled_date_change") {
    if (!canEdit(status)) {
      return refuse(status, `Cannot edit an item that is ${status}.`);
    }
    // Legal, but nothing was approved yet, so the status does not move.
    return { ok: true, status, unschedule: false };
  }

  // Approval is the one cause whose target depends on who acted: the internal
  // reviewer moves an item to internal_approved, the client to client_approved.
  // Every other cause has a single target.
  const target = cause === "approve" ? approvalTargetFor(input.stage) : targetFor(cause);
  if (!target) {
    return refuse(
      status,
      cause === "approve"
        ? `An approval must name its stage — "internal" or "client".`
        : `No target status for cause "${cause}".`,
    );
  }
  if (!isLegalTransition(status, target)) {
    return refuse(status, `Illegal transition: ${status} -> ${target} (${cause}).`);
  }

  return { ok: true, status: target, unschedule: false };
}

/**
 * Where an approval lands, by stage. The stage is required: an approval that
 * does not say who gave it cannot be applied, because internal and client
 * approval are different facts about the item.
 */
function approvalTargetFor(stage: ApprovalStage | undefined): ContentStatus | null {
  if (stage === "internal") return "internal_approved";
  if (stage === "client") return "client_approved";
  return null;
}

/** The status each non-invalidating cause moves toward. */
function targetFor(cause: TransitionCause): ContentStatus | null {
  switch (cause) {
    case "start_refinement":
      return "in_refinement";
    case "submit_for_review":
      return "pending_internal_review";
    case "schedule":
      return "scheduled";
    case "publish_started":
      return "publishing";
    case "publish_succeeded":
      return "published";
    case "publish_failed":
      return "publish_failed";
    case "retry_publish":
      return "scheduled";
    case "flag":
      return "flagged";
    case "resolve_flag":
      return "drafted";
    default:
      return null;
  }
}

const KNOWN_CAUSES = new Set<string>([
  "submit_for_review",
  "start_refinement",
  "approve",
  "decline",
  "content_edit",
  "scheduled_date_change",
  "schedule",
  "publish_started",
  "publish_succeeded",
  "publish_failed",
  "retry_publish",
  "flag",
  "resolve_flag",
]);

function isKnownCause(cause: string): cause is TransitionCause {
  return KNOWN_CAUSES.has(cause);
}
