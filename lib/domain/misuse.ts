import { prisma, type Db } from "../db";
import { writeAudit } from "./auditLog";
import { CLAUSE_APPROVAL_GATE, detectOverrideAttempt } from "./overrideDetection";

/**
 * One entry point for everything the Admin should see.
 *
 * Misuse detection scattered across layers is misuse detection that gets
 * forgotten in the next endpoint. Every category routes through `raiseFlag`, so
 * the queue in `P11.4` has exactly one thing to read and the severity ranking
 * is decided in one place rather than per caller.
 *
 * Two kinds of flag share the `Flag` table because both mean "route this to a
 * human". They differ in who reads them:
 *
 *   content     — about the work. The engine raises them; the account manager
 *                 handling that brief resolves them.
 *   governance  — about a person's conduct. Raised anywhere; the Agency Admin
 *                 is the only reader.
 *
 * `raised_against_id` and `severity` are what separate them in practice: a
 * content flag is about a brief and names nobody.
 */

/** Raised by the engine, about the work. */
export const CONTENT_FLAG_TYPES = [
  "brand_violation",
  "compliance_violation",
  "unknown_client",
  "inactive_client",
] as const;

/** Raised anywhere, about conduct. The Admin's queue. */
export const GOVERNANCE_FLAG_TYPES = [
  "approval_override_attempt",
  "role_boundary_violation",
  "cross_client_data",
  "off_task_generation",
  "approval_churn",
] as const;

export type ContentFlagType = (typeof CONTENT_FLAG_TYPES)[number];
export type GovernanceFlagType = (typeof GOVERNANCE_FLAG_TYPES)[number];
export type AnyFlagType = ContentFlagType | GovernanceFlagType;

export type Severity = "high" | "medium" | "low";

/**
 * Severity is a property of the category, not of the caller's mood.
 *
 * Fixed here so one noisy detector cannot inflate its own rows to the top of the
 * queue. Churn is deliberately `low`: it is a process signal, and letting it
 * rank alongside a real breach would drown the rows that matter.
 */
const SEVERITY_BY_TYPE: Record<GovernanceFlagType, Severity> = {
  // A deliberate attempt to get past the approval gate, or past client isolation.
  approval_override_attempt: "high",
  role_boundary_violation: "high",
  cross_client_data: "high",
  // Misusing the tool, but not aimed at a guarantee.
  off_task_generation: "medium",
  // A process signal rather than a rule breach.
  approval_churn: "low",
};

export function severityFor(flagType: GovernanceFlagType): Severity {
  return SEVERITY_BY_TYPE[flagType];
}

export function isGovernanceFlag(flagType: string): flagType is GovernanceFlagType {
  return (GOVERNANCE_FLAG_TYPES as readonly string[]).includes(flagType);
}

export function isContentFlag(flagType: string): flagType is ContentFlagType {
  return (CONTENT_FLAG_TYPES as readonly string[]).includes(flagType);
}

export class UnknownFlagTypeError extends Error {
  readonly code = "UNKNOWN_FLAG_TYPE";
  constructor(flagType: string) {
    super(
      `"${flagType}" is not a known flag type. Expected one of: ` +
        [...CONTENT_FLAG_TYPES, ...GOVERNANCE_FLAG_TYPES].join(", "),
    );
    this.name = "UnknownFlagTypeError";
  }
}

export type RaiseFlagInput = {
  flagType: AnyFlagType | string;
  /** Who did it. Required for governance flags — a conduct flag naming nobody
   *  is unactionable. Null for engine-raised content flags. */
  raisedAgainstId?: string | null;
  campaignId?: string | null;
  contentItemId?: string | null;
  /** The clause breached, for content flags. Governance flags breach a role
   *  boundary rather than a clause. */
  clauseId?: string | null;
  /** What makes the row actionable: the matched phrase, the client reached for,
   *  the decline count. */
  details?: unknown;
  /** Overrides the category default. Only narrows for a documented reason. */
  severity?: Severity;
};

/**
 * Raise a flag. The single entry point.
 *
 * Never throws for a detection that fired — a flag failing to record because a
 * campaign id was stale would lose the very evidence it exists to keep. It does
 * throw on an unknown `flagType`, because that is a programming error rather
 * than a runtime condition.
 */
export async function raiseFlag(input: RaiseFlagInput, db: Db = prisma) {
  const {
    flagType,
    raisedAgainstId = null,
    campaignId = null,
    contentItemId = null,
    clauseId = null,
    details,
    severity,
  } = input;

  if (!isGovernanceFlag(flagType) && !isContentFlag(flagType)) {
    throw new UnknownFlagTypeError(flagType);
  }

  const resolvedSeverity: Severity =
    severity ?? (isGovernanceFlag(flagType) ? severityFor(flagType) : "high");

  const created = await db.flag.create({
    data: {
      flag_type: flagType,
      severity: resolvedSeverity,
      raised_against_id: raisedAgainstId,
      campaign_id: campaignId,
      content_item_id: contentItemId,
      clause_id: clauseId,
      details: details === undefined ? null : JSON.stringify(details),
    },
  });

  // The trail records the raising as its own event. A flag that was later
  // resolved still leaves proof of when it fired and against whom.
  await writeAudit(
    {
      entityType: "Flag",
      entityId: created.flag_id,
      action: "flag_raised",
      // The actor is the system detecting, not the person detected. Recording
      // the subject as the performer would read as though they raised it.
      performedById: null,
      details: {
        flag_type: flagType,
        severity: resolvedSeverity,
        raised_against_id: raisedAgainstId,
      },
    },
    db,
  );

  return created;
}

// --- The five governance categories --------------------------------------
//
// Named wrappers rather than raw `raiseFlag` calls, so a caller cannot pick the
// wrong type or forget the context that makes a row actionable.

/**
 * Bypass language in a brief or a `PostRequest` comment.
 *
 * Reuses `P2.10`'s detection. The comment path matters: the PRD says a comment
 * carries no approval authority, so an attempt made there is still an attempt
 * and is still recorded.
 */
export async function flagOverrideAttempt(
  input: {
    text: string;
    raisedAgainstId: string;
    campaignId?: string | null;
    contentItemId?: string | null;
    /** brief | comment — where the language appeared. */
    source: "brief" | "comment";
  },
  db: Db = prisma,
) {
  const detection = detectOverrideAttempt(input.text);
  if (!detection.detected) return null;

  return raiseFlag(
    {
      flagType: "approval_override_attempt",
      raisedAgainstId: input.raisedAgainstId,
      campaignId: input.campaignId ?? null,
      contentItemId: input.contentItemId ?? null,
      details: {
        source: input.source,
        matches: detection.matches,
        kinds: detection.kinds,
        clause: CLAUSE_APPROVAL_GATE,
      },
    },
    db,
  );
}

/**
 * A user attempting what their role forbids.
 *
 * `P2.13` routes every denial here. Without it a refusal is silent, and a person
 * probing what they can reach leaves no trace at all.
 */
export async function flagRoleBoundaryViolation(
  input: {
    raisedAgainstId: string;
    /** The capability they attempted, from `P2.13`'s vocabulary. */
    action: string;
    role: string;
    clientId?: string | null;
    reason?: string;
  },
  db: Db = prisma,
) {
  return raiseFlag(
    {
      flagType: "role_boundary_violation",
      raisedAgainstId: input.raisedAgainstId,
      details: {
        action: input.action,
        role: input.role,
        client_id: input.clientId ?? null,
        reason: input.reason ?? null,
      },
    },
    db,
  );
}

/**
 * A tripwire, not a routine path.
 *
 * Retrieval scoping makes cross-client access structurally impossible, so a row
 * here means a real bug or a real attempt. Always `high`, and never downgraded.
 */
export async function flagCrossClientAccess(
  input: {
    raisedAgainstId: string;
    /** The client they may see. */
    ownClientIds: string[];
    /** The client they reached for. */
    attemptedClientId: string;
    action?: string;
  },
  db: Db = prisma,
) {
  return raiseFlag(
    {
      flagType: "cross_client_data",
      raisedAgainstId: input.raisedAgainstId,
      severity: "high",
      details: {
        attempted_client_id: input.attemptedClientId,
        own_client_ids: input.ownClientIds,
        action: input.action ?? null,
      },
    },
    db,
  );
}

/**
 * A creator using the engine for something off-task (`P3.11`, `P14.8`).
 *
 * Raised from both surfaces: the item-level regeneration prompt, and a
 * conversation turn. When it comes from a conversation, `conversationId` is
 * recorded so the Admin's queue row can open the thread around the refused turn
 * rather than showing an isolated excerpt -- which is the difference between
 * "this person typed something odd once" and "this person spent nine turns
 * trying to get the tool to write their CV".
 */
export async function flagOffTaskGeneration(
  input: {
    raisedAgainstId: string;
    prompt: string;
    contentItemId?: string | null;
    reason?: string;
    conversationId?: string | null;
  },
  db: Db = prisma,
) {
  return raiseFlag(
    {
      flagType: "off_task_generation",
      raisedAgainstId: input.raisedAgainstId,
      contentItemId: input.contentItemId ?? null,
      details: {
        // Truncated: enough for the Admin to judge, without the queue becoming a
        // transcript of everything anyone ever typed. Where the refusal came
        // from a conversation, the full thread is a click away via
        // `conversation_id`, so the excerpt is a summary rather than the whole
        // record.
        prompt: input.prompt.slice(0, 500),
        reason: input.reason ?? null,
        conversation_id: input.conversationId ?? null,
      },
    },
    db,
  );
}

/** An item declined more times than this is a process signal worth surfacing. */
export const CHURN_DECLINE_THRESHOLD = 3;

/**
 * Approval churn on one item.
 *
 * Deliberately not raised per decline. One flag per item, updated in place, so
 * the twelfth decline does not push eleven other rows off the Admin's screen.
 */
export async function flagApprovalChurn(
  input: {
    contentItemId: string;
    declineCount: number;
    campaignId?: string | null;
    raisedAgainstId?: string | null;
  },
  db: Db = prisma,
) {
  if (input.declineCount < CHURN_DECLINE_THRESHOLD) return null;

  const existing = await db.flag.findFirst({
    where: {
      content_item_id: input.contentItemId,
      flag_type: "approval_churn",
      resolved: false,
    },
  });

  if (existing) {
    return db.flag.update({
      where: { flag_id: existing.flag_id },
      data: { details: JSON.stringify({ decline_count: input.declineCount }) },
    });
  }

  return raiseFlag(
    {
      flagType: "approval_churn",
      contentItemId: input.contentItemId,
      campaignId: input.campaignId ?? null,
      raisedAgainstId: input.raisedAgainstId ?? null,
      details: { decline_count: input.declineCount },
    },
    db,
  );
}

// --- The Admin's queue ----------------------------------------------------

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/**
 * Open flags the Admin should read, worst first.
 *
 * Two kinds qualify, and the second is the subtle one:
 *
 *   1. **Every governance flag.** Misuse is always the Admin's, and always
 *      recorded the moment it happens -- the act is the evidence.
 *   2. **A content flag someone submitted anyway.** The engine declining to
 *      draft something raises nothing at all now (see `queueOrFlag`), because a
 *      refusal a creator reads and abandons is not evidence. But a creator who
 *      submits the flagged item *past* that refusal has done something the Admin
 *      should see, and `submitForReview` raises the row then.
 *
 * `raised_against_id` is what tells the two apart, and it is not an incidental
 * field to key on: a content flag names nobody by construction, so a content
 * flag that *does* name someone can only have come from a person submitting one.
 * Routine engine refusals stay out of this queue because they no longer exist as
 * rows at all.
 */
export async function openGovernanceFlags(
  options: { includeResolved?: boolean } = {},
  db: Db = prisma,
) {
  const rows = await db.flag.findMany({
    where: {
      OR: [
        { flag_type: { in: [...GOVERNANCE_FLAG_TYPES] } },
        // A content violation someone stood behind. See above.
        {
          flag_type: { in: [...CONTENT_FLAG_TYPES] },
          raised_against_id: { not: null },
        },
      ],
      ...(options.includeResolved ? {} : { resolved: false }),
    },
    include: {
      raised_against: { select: { user_id: true, name: true, email: true } },
    },
  });

  // Sorted here rather than in SQL: "high" < "low" alphabetically, so an ORDER
  // BY on the column would rank churn above real breaches.
  return rows.sort((a, b) => {
    const bySeverity =
      SEVERITY_RANK[a.severity as Severity] - SEVERITY_RANK[b.severity as Severity];
    if (bySeverity !== 0) return bySeverity;
    return b.created_at.getTime() - a.created_at.getTime();
  });
}

/** Resolve a flag with notes. Writes `flag_resolved` to the trail. */
export async function resolveFlag(
  input: { flagId: string; notes: string; byAdminId: string },
  db: Db = prisma,
) {
  const updated = await db.flag.update({
    where: { flag_id: input.flagId },
    data: {
      resolved: true,
      resolution_notes: input.notes,
      resolved_at: new Date(),
    },
  });

  await writeAudit(
    {
      entityType: "Flag",
      entityId: input.flagId,
      action: "flag_resolved",
      performedById: input.byAdminId,
      details: { notes: input.notes },
    },
    db,
  );

  return updated;
}
