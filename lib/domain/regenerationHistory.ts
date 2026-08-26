import path from "node:path";

import { prisma, type Db } from "../db";
import { clientScopeWhere, type ScopeUser } from "./accessScope";

/**
 * Which reference produced which draft.
 *
 * The ERD's reason for accumulating `ReferenceAttachment` rows rather than
 * overwriting them, made visible: "rows accumulate across regenerations rather
 * than being overwritten, so a reviewer can see exactly which reference produced
 * which version."
 *
 * Assembled from two sources, because neither alone answers the question. The
 * attachments say what was supplied; the `AuditLog` rows written by
 * `regenerateItem` say when a regeneration ran and which attachments it used.
 * Pairing them by the `reference_ids` the audit row records is what turns "here
 * are four files" into "this file produced that draft".
 *
 * **No version snapshots are stored, and this does not invent them.** A
 * `ContentItem` carries its current body and nothing else -- the product keeps a
 * revision *history* in the audit trail, not a revision *store*. So a run is
 * reported as an event with its references and its outcome, not as a diff
 * against text that was never kept. Claiming otherwise on screen would be the
 * "visible, not just claimed" this task asks for, inverted.
 *
 * Scoped through `clientScopeWhere` like every other read: an item outside the
 * caller's scope yields an empty history rather than someone else's.
 */

export type HistoryReference = {
  attachment_id: string;
  file_type: string;
  /** A browser-reachable path under `/uploads/references`, not the disk path. */
  public_url: string;
  instruction: string | null;
  uploaded_by_id: string | null;
  uploaded_by_name: string | null;
  created_at: Date;
};

export type HistoryRun = {
  audit_id: string;
  performed_at: Date;
  performed_by_id: string | null;
  performed_by_name: string | null;
  from_status: string | null;
  to_status: string | null;
  /** The references this run was prompted with, in upload order. */
  references: HistoryReference[];
};

export type RegenerationHistory = {
  runs: HistoryRun[];
  /**
   * Attachments not claimed by any recorded run.
   *
   * A regeneration that was *refused* stores its references and returns before
   * writing an edit row -- which is deliberate: a reference that produced a
   * flagged result is exactly the one worth seeing. Those rows would otherwise
   * vanish from this view, so they are surfaced separately rather than dropped.
   */
  unattributed: HistoryReference[];
};

export async function regenerationHistory(
  user: ScopeUser,
  contentItemId: string,
  db: Db = prisma,
): Promise<RegenerationHistory> {
  const scope = await clientScopeWhere(user, db);

  const item = await db.contentItem.findFirst({
    where: { content_item_id: contentItemId, campaign: { is: scope } },
    select: { content_item_id: true },
  });

  if (!item) return { runs: [], unattributed: [] };

  const [attachments, auditRows] = await Promise.all([
    db.referenceAttachment.findMany({
      where: { content_item_id: contentItemId },
      orderBy: { created_at: "asc" },
      select: {
        attachment_id: true,
        file_type: true,
        storage_url: true,
        instruction: true,
        created_at: true,
        uploaded_by_id: true,
        uploaded_by: { select: { name: true } },
      },
    }),
    db.auditLog.findMany({
      where: { entity_type: "ContentItem", entity_id: contentItemId, action: "edited" },
      orderBy: { performed_at: "asc" },
      select: {
        audit_id: true,
        details: true,
        performed_at: true,
        performed_by_id: true,
        performed_by: { select: { name: true } },
      },
    }),
  ]);

  const byId = new Map(
    attachments.map((a) => [
      a.attachment_id,
      {
        attachment_id: a.attachment_id,
        file_type: a.file_type,
        public_url: publicUrlFor(a.storage_url),
        instruction: a.instruction,
        uploaded_by_id: a.uploaded_by_id,
        uploaded_by_name: a.uploaded_by?.name ?? null,
        created_at: a.created_at,
      } satisfies HistoryReference,
    ]),
  );

  const claimed = new Set<string>();
  const runs: HistoryRun[] = [];

  for (const row of auditRows) {
    const details = parseDetails(row.details);
    const referenceIds = asStringArray(details.reference_ids);

    // An `edited` row with no `reference_ids` key is a hand edit or a submit,
    // not a regeneration. Only regenerations belong in this view -- everything
    // else is in the audit log, which is where the full trail lives.
    if (!Array.isArray(details.reference_ids)) continue;

    const references = referenceIds
      .map((id) => byId.get(id))
      .filter((reference): reference is HistoryReference => Boolean(reference));

    for (const reference of references) claimed.add(reference.attachment_id);

    runs.push({
      audit_id: row.audit_id,
      performed_at: row.performed_at,
      performed_by_id: row.performed_by_id,
      performed_by_name: row.performed_by?.name ?? null,
      from_status: asStringOrNull(details.from_status),
      to_status: asStringOrNull(details.to_status),
      references,
    });
  }

  return {
    runs: runs.reverse(),
    unattributed: attachments
      .filter((a) => !claimed.has(a.attachment_id))
      .map((a) => byId.get(a.attachment_id)!)
      .reverse(),
  };
}

/**
 * The browser path for a stored reference.
 *
 * `storage_url` is an absolute disk path, because `regenerateItem` reads the
 * bytes with `readFile` rather than serving them. The basename is enough to
 * rebuild the public path, and deriving it here rather than storing a second
 * column keeps one fact in one place -- moving the upload directory then changes
 * one constant instead of every historical row.
 */
function publicUrlFor(storageUrl: string): string {
  return `/uploads/references/${path.basename(storageUrl)}`;
}

/** `AuditLog.details` is free-form JSON, stored as text. */
function parseDetails(details: unknown): Record<string, unknown> {
  if (details === null || details === undefined) return {};
  if (typeof details === "object") return details as Record<string, unknown>;
  if (typeof details !== "string") return {};
  try {
    const parsed = JSON.parse(details);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    // A details blob that will not parse is a corrupt row, not a reason to fail
    // a read: the run is still reported, just without its references.
    return {};
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A history, ready to cross into a client component. */
export function serializeHistory(history: RegenerationHistory) {
  const reference = (r: HistoryReference) => ({
    attachment_id: r.attachment_id,
    file_type: r.file_type,
    public_url: r.public_url,
    instruction: r.instruction,
    uploaded_by_id: r.uploaded_by_id,
    uploaded_by_name: r.uploaded_by_name,
    created_at: r.created_at.toISOString(),
  });

  return {
    runs: history.runs.map((run) => ({
      audit_id: run.audit_id,
      performed_at: run.performed_at.toISOString(),
      performed_by_id: run.performed_by_id,
      performed_by_name: run.performed_by_name,
      from_status: run.from_status,
      to_status: run.to_status,
      references: run.references.map(reference),
    })),
    unattributed: history.unattributed.map(reference),
  };
}

export type HistorySerialized = ReturnType<typeof serializeHistory>;
