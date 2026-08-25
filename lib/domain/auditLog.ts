import { prisma, type Db } from "../db";

/**
 * The append-only audit trail.
 *
 * Written first, before any other domain function, so that recording a state
 * change is a habit every later rule inherits rather than a retrofit in
 * Phase 11. Every domain function that mutates state calls this.
 *
 * Rows are never updated and never deleted.
 */

/** Actions the trail records. Matches AuditLog.action in the ERD. */
export const AUDIT_ACTIONS = [
  "created",
  "edited",
  "scheduled",
  "rescheduled",
  "deleted",
  "approved",
  "declined",
  "flag_raised",
  "flag_resolved",
  "published",
  "take_down",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Entity types the trail refers to. Kept open -- entity_type is a string. */
export type AuditEntityType =
  | "Client"
  | "Campaign"
  | "ContentItem"
  | "Approval"
  | "Flag"
  | "BrandGuideVersion"
  | "PlatformConnection"
  | "PostRequest"
  | "Comment"
  | "MediaAsset"
  | "ReferenceAttachment"
  | "ClientAssignment"
  | "LoginOtp"
  // A password being set or changed. The row records that it happened and by
  // whom -- never the password, and never the hash.
  | "User";

export type WriteAuditInput = {
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  /** Null for system actions -- the scheduler publishing, an engine flag. */
  performedById?: string | null;
  /** Free-form context: what changed, and from what to what. */
  details?: unknown;
};

/**
 * Pass a transaction as `db` so the audit row commits or rolls back with the
 * change it describes -- a trail that records something that did not happen is
 * worse than no trail.
 */
export async function writeAudit(input: WriteAuditInput, db: Db = prisma) {
  const { entityType, entityId, action, performedById = null, details } = input;

  if (!AUDIT_ACTIONS.includes(action)) {
    throw new Error(`Unknown audit action "${action}"`);
  }
  if (!entityId) {
    throw new Error(`writeAudit requires an entityId (${entityType}/${action})`);
  }

  return db.auditLog.create({
    data: {
      entity_type: entityType,
      entity_id: entityId,
      action,
      performed_by_id: performedById,
      details: details === undefined ? null : JSON.stringify(details),
    },
  });
}

/** Reads the trail for one entity, newest first. */
export async function getAuditTrail(
  entityType: AuditEntityType,
  entityId: string,
  db: Db = prisma,
) {
  return db.auditLog.findMany({
    where: { entity_type: entityType, entity_id: entityId },
    orderBy: { performed_at: "desc" },
  });
}
