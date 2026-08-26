import { prisma, type Db } from "../db";
import {
  DEFAULT_PAGE_SIZE,
  toPage,
  toSkipTake,
  type Page,
  type PageRequest,
} from "./pagination";

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
  // Dispatching an item to a creator (Phase 14). Its own action rather than an
  // `edited` row: who was handed the work is a different question from what the
  // work says, and a reviewer reading the trail should not have to open the
  // details blob to tell the two apart.
  "assigned",
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
  | "Conversation"
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

// --- The Admin's reading of the trail --------------------------------------

/**
 * The audit log, filtered.
 *
 * Cross-client by design and by omission: there is no scope parameter, because
 * the one view in the product that is not scoped is this one. `P11.3` says so
 * explicitly, and the route above it checks `audit.view`, which only the agency
 * admin holds. A scope argument here would invite a caller to pass one and
 * quietly make the oversight view partial.
 *
 * Filtering by client is done through the entity rather than a column: the trail
 * stores `entity_type` and `entity_id`, not a client, because an `AuditLog` row
 * is about a *thing that changed* and some of those things -- a user, a session
 * -- belong to no client at all. So a client filter resolves to the set of
 * entity ids owned by that client and matches on those.
 */
export type AuditFilters = {
  clientId?: string | null;
  entityType?: string | null;
  action?: string | null;
  actorId?: string | null;
};

export type AuditRow = {
  audit_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  details: string | null;
  performed_at: Date;
  performed_by: { user_id: string; name: string } | null;
};

export async function readAuditLog(
  filters: AuditFilters = {},
  page: PageRequest = { page: 1, pageSize: DEFAULT_PAGE_SIZE },
  db: Db = prisma,
): Promise<Page<AuditRow>> {
  const conditions: Record<string, unknown>[] = [];

  if (filters.entityType) conditions.push({ entity_type: filters.entityType });
  if (filters.action) conditions.push({ action: filters.action });
  if (filters.actorId) conditions.push({ performed_by_id: filters.actorId });

  if (filters.clientId) {
    conditions.push({ entity_id: { in: await entityIdsForClient(filters.clientId, db) } });
  }

  const where = conditions.length > 0 ? { AND: conditions } : {};
  const { skip, take } = toSkipTake(page);

  const [rows, total] = await Promise.all([
    db.auditLog.findMany({
      where,
      orderBy: { performed_at: "desc" },
      skip,
      take,
      include: { performed_by: { select: { user_id: true, name: true } } },
    }),
    db.auditLog.count({ where }),
  ]);

  return toPage(rows as AuditRow[], total, page);
}

/**
 * Every entity id a client owns, for the client filter.
 *
 * Deliberately a set of ids rather than a join: `AuditLog` has no foreign key to
 * anything, because it must survive the deletion of what it describes. That is
 * the cost of an append-only trail that outlives its subjects, and this is where
 * it is paid.
 */
async function entityIdsForClient(clientId: string, db: Db): Promise<string[]> {
  const [campaigns, requests, guides, connections, assignments, conversations] =
    await Promise.all([
      db.campaign.findMany({ where: { client_id: clientId }, select: { campaign_id: true } }),
      db.postRequest.findMany({
        where: { client_id: clientId },
        select: { post_request_id: true },
      }),
      db.brandGuideVersion.findMany({
        where: { client_id: clientId },
        select: { brand_guide_version_id: true },
      }),
      db.platformConnection.findMany({
        where: { client_id: clientId },
        select: { platform_connection_id: true },
      }),
      db.clientAssignment.findMany({
        where: { client_id: clientId },
        select: { assignment_id: true },
      }),
      db.conversation.findMany({
        where: { client_id: clientId },
        select: { conversation_id: true },
      }),
    ]);

  const campaignIds = campaigns.map((row) => row.campaign_id);

  // Content items and their approvals are the bulk of the trail, and both are
  // reached through the campaign rather than directly from the client.
  const items = await db.contentItem.findMany({
    where: { campaign_id: { in: campaignIds } },
    select: { content_item_id: true },
  });

  return [
    clientId,
    ...campaignIds,
    ...items.map((row) => row.content_item_id),
    ...requests.map((row) => row.post_request_id),
    ...guides.map((row) => row.brand_guide_version_id),
    ...connections.map((row) => row.platform_connection_id),
    ...assignments.map((row) => row.assignment_id),
    ...conversations.map((row) => row.conversation_id),
  ];
}

/** The distinct actors who appear in the trail, for the filter bar. */
export async function auditActors(db: Db = prisma) {
  const rows = await db.auditLog.findMany({
    where: { performed_by_id: { not: null } },
    select: { performed_by: { select: { user_id: true, name: true } } },
    distinct: ["performed_by_id"],
    orderBy: { performed_at: "desc" },
  });

  return rows
    .map((row) => row.performed_by)
    .filter((user): user is { user_id: string; name: string } => user !== null);
}
