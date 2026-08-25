import { prisma, type Db } from "../db";
import { writeAudit } from "./auditLog";
import { parseClauseLines } from "./parseGuidelines";

/**
 * A client's brand guide, and the one gate that makes editing it safe.
 *
 * The rule this module exists to enforce is PRD §6: a guide is "fully editable
 * in-app by the account manager, with version history, gated behind client
 * approval before a new version takes effect". Two halves, and the second is the
 * load-bearing one -- an account manager who could change what the engine
 * grounds in, unilaterally, would be able to rewrite a client's rules and have
 * every subsequent draft cite the new wording as though the client had agreed to
 * it.
 *
 * So the lifecycle is deliberately small:
 *
 *   draft -- (submit) --> pending_client_approval -- (client approves) --> active
 *                                                 \- (client declines) --> draft
 *
 * and activating a version is the *only* thing that moves
 * `Client.active_brand_guide_id`. `retrievalScope.getGuidelinesForClient` reads
 * that column and nothing else, so "which rules govern this client right now"
 * has exactly one answer, written in exactly one place.
 *
 * **Only one version per client is ever active.** Activation supersedes the
 * outgoing version in the same transaction that promotes the incoming one, so
 * there is no instant at which a client has two active guides or none.
 *
 * Past versions are superseded, never deleted. `ContentItem` freezes the
 * `grounded_brand_guide_version_id` it was drafted under, and a deleted version
 * would turn every one of those references into a dangling claim about what a
 * draft was checked against.
 */

export const BRAND_GUIDE_STATUSES = [
  "draft",
  "pending_client_approval",
  "active",
  "superseded",
] as const;

export type BrandGuideStatus = (typeof BRAND_GUIDE_STATUSES)[number];

export class BrandGuideValidationError extends Error {
  readonly code = "BRAND_GUIDE_VALIDATION";
  /** Field-keyed so an edit form can show each message against its input. */
  readonly issues: Record<string, string>;

  constructor(issues: Record<string, string>) {
    super(`Invalid brand guide: ${Object.keys(issues).join(", ")}.`);
    this.name = "BrandGuideValidationError";
    this.issues = issues;
  }
}

/**
 * The version exists, but its current status refuses this action -- approving
 * one never submitted for approval, or submitting one already with the client.
 *
 * Separate from the validation error because the body was well-formed: it is the
 * row's state that refuses, and the caller needs the status to say so.
 */
export class BrandGuideNotAllowedError extends Error {
  readonly code = "BRAND_GUIDE_NOT_ALLOWED";
  readonly status: BrandGuideStatus;

  constructor(message: string, status: BrandGuideStatus) {
    super(message);
    this.name = "BrandGuideNotAllowedError";
    this.status = status;
  }
}

export class BrandGuideNotFoundError extends Error {
  readonly code = "BRAND_GUIDE_NOT_FOUND";
  constructor(versionId: string) {
    super(`No brand guide version "${versionId}".`);
    this.name = "BrandGuideNotFoundError";
  }
}

export type BrandGuideVersionRow = {
  brand_guide_version_id: string;
  client_id: string;
  version_number: number;
  status: string;
  created_by_id: string | null;
  client_approved_by_id: string | null;
  created_at: Date;
  approved_at: Date | null;
};

/** One clause as supplied by the author, before it becomes a row. */
export type ClauseInput = {
  clause_code: string;
  title: string;
  text: string;
};

export type CreateVersionInput = {
  clientId: string;
  /**
   * The guide's clauses, as structured rows.
   *
   * Alternatively `markdown` -- the form the seeded guides are authored in --
   * which is parsed into the same shape.
   */
  clauses?: ClauseInput[];
  markdown?: string;
  /** Submit straight for client approval rather than leaving it a draft. */
  submitForApproval?: boolean;
};

export type BrandGuideVersionWithClauses = BrandGuideVersionRow & {
  clauses: { clause_id: string; clause_code: string; title: string; text: string }[];
};

/**
 * Draft a new version of a client's guide.
 *
 * The new version is **never** active on creation, whatever the caller asks for:
 * it is born `draft`, or `pending_client_approval` if submitted immediately. The
 * client's active guide is untouched until they approve, so an account manager
 * mid-edit cannot change what the engine is drafting against right now.
 *
 * `version_number` is the client's current maximum plus one, computed inside the
 * transaction so two account managers saving at once cannot both claim the same
 * number.
 */
export async function createBrandGuideVersion(
  input: CreateVersionInput,
  createdById: string,
  db: Db = prisma,
): Promise<BrandGuideVersionWithClauses> {
  const issues: Record<string, string> = {};

  const clientId = (input.clientId ?? "").trim();
  if (!clientId) issues.clientId = "A brand guide names the client it governs.";

  const clauses = normalizeClauses(input, issues);

  if (Object.keys(issues).length > 0) throw new BrandGuideValidationError(issues);

  // Checked rather than left to the foreign key: an FK failure surfaces as a 500
  // with a Prisma message, and "no such client" is a caller error the form
  // should be able to show against its own field.
  const client = await db.client.findUnique({
    where: { client_id: clientId },
    select: { client_id: true },
  });
  if (!client) {
    throw new BrandGuideValidationError({ clientId: `No client ${clientId} on the roster.` });
  }

  const status: BrandGuideStatus = input.submitForApproval ? "pending_client_approval" : "draft";

  return db.$transaction(async (tx) => {
    const latest = await tx.brandGuideVersion.findFirst({
      where: { client_id: clientId },
      orderBy: { version_number: "desc" },
      select: { version_number: true },
    });

    const version = await tx.brandGuideVersion.create({
      data: {
        client_id: clientId,
        version_number: (latest?.version_number ?? 0) + 1,
        status,
        created_by_id: createdById,
      },
    });

    // Written as source_type = "brand" and tied to this version. Agency clauses
    // are global and unversioned; nothing here can create one, so an in-app edit
    // cannot rewrite the standards that govern every client.
    await tx.guidelineClause.createMany({
      data: clauses.map((c) => ({
        source_type: "brand",
        brand_guide_version_id: version.brand_guide_version_id,
        clause_code: c.clause_code,
        title: c.title,
        text: c.text,
      })),
    });

    await writeAudit(
      {
        entityType: "BrandGuideVersion",
        entityId: version.brand_guide_version_id,
        action: "created",
        performedById: createdById,
        details: {
          client_id: clientId,
          version_number: version.version_number,
          status,
          clause_count: clauses.length,
        },
      },
      tx,
    );

    return withClauses(tx, version);
  });
}

/**
 * Send a draft to the client for sign-off.
 *
 * The moment the account manager's edit window closes. Kept separate from
 * creation so an author can save a half-finished guide without putting it in
 * front of the client -- and so the client's queue only ever holds versions
 * someone deliberately submitted.
 */
export async function submitForClientApproval(
  versionId: string,
  submittedById: string,
  db: Db = prisma,
): Promise<BrandGuideVersionRow> {
  const existing = await requireVersion(versionId, db);
  const status = existing.status as BrandGuideStatus;

  if (status !== "draft") {
    throw new BrandGuideNotAllowedError(
      status === "pending_client_approval"
        ? "That version is already with the client."
        : `Cannot submit a version that is ${status}.`,
      status,
    );
  }

  // A version with no clauses would activate into a guide that says nothing, and
  // `getGuidelinesForClient` would then return agency clauses alone while
  // reporting that a brand guide is on file.
  const clauseCount = await db.guidelineClause.count({
    where: { brand_guide_version_id: versionId },
  });
  if (clauseCount === 0) {
    throw new BrandGuideValidationError({ clauses: "A guide needs at least one clause." });
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.brandGuideVersion.update({
      where: { brand_guide_version_id: versionId },
      data: { status: "pending_client_approval" },
    });

    await writeAudit(
      {
        entityType: "BrandGuideVersion",
        entityId: versionId,
        action: "edited",
        performedById: submittedById,
        details: { from_status: "draft", to_status: "pending_client_approval" },
      },
      tx,
    );

    return updated;
  });
}

/**
 * The client approves -- and only now does the new version take effect.
 *
 * Three writes, one transaction, because they are one fact: the outgoing version
 * is superseded, the incoming one becomes active, and
 * `Client.active_brand_guide_id` points at it. Splitting them would leave a
 * window in which the engine reads a client with two active versions, or with an
 * `active_brand_guide_id` naming a version still marked pending.
 *
 * `client_approved_by_id` records *which* contact signed off, not merely that
 * someone did -- the same reason `Approval.decided_by_id` exists on content.
 */
export async function approveBrandGuideVersion(
  versionId: string,
  approvedById: string,
  db: Db = prisma,
): Promise<BrandGuideVersionRow> {
  const existing = await requireVersion(versionId, db);
  const status = existing.status as BrandGuideStatus;

  if (status !== "pending_client_approval") {
    throw new BrandGuideNotAllowedError(
      status === "active"
        ? "That version is already the active guide."
        : `Cannot approve a version that is ${status}.`,
      status,
    );
  }

  return db.$transaction(async (tx) => {
    // Superseded by client, not by version number: the outgoing active version
    // is whichever one is active now, which is not necessarily the immediately
    // preceding number if a draft was abandoned along the way.
    await tx.brandGuideVersion.updateMany({
      where: {
        client_id: existing.client_id,
        status: "active",
        NOT: { brand_guide_version_id: versionId },
      },
      data: { status: "superseded" },
    });

    const updated = await tx.brandGuideVersion.update({
      where: { brand_guide_version_id: versionId },
      data: {
        status: "active",
        client_approved_by_id: approvedById,
        approved_at: new Date(),
      },
    });

    await tx.client.update({
      where: { client_id: existing.client_id },
      data: { active_brand_guide_id: versionId },
    });

    await writeAudit(
      {
        entityType: "BrandGuideVersion",
        entityId: versionId,
        action: "approved",
        performedById: approvedById,
        details: {
          client_id: existing.client_id,
          version_number: existing.version_number,
          superseded_version_id: existing.previously_active_id,
        },
      },
      tx,
    );

    return updated;
  });
}

/**
 * The client says no, and the version goes back to its author as a draft.
 *
 * Back to `draft` rather than to a terminal `declined` status, for the same
 * reason a declined `ContentItem` resets to `drafted` rather than bouncing into
 * the reviewer's queue: the version needs fixing by whoever wrote it, and it
 * re-enters the client's queue only when someone deliberately resubmits it.
 *
 * The active guide is untouched throughout. A declined new version does not
 * disturb the rules the engine is currently drafting against.
 */
export async function declineBrandGuideVersion(
  versionId: string,
  declinedById: string,
  reason: string | null,
  db: Db = prisma,
): Promise<BrandGuideVersionRow> {
  const existing = await requireVersion(versionId, db);
  const status = existing.status as BrandGuideStatus;

  if (status !== "pending_client_approval") {
    throw new BrandGuideNotAllowedError(`Cannot decline a version that is ${status}.`, status);
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.brandGuideVersion.update({
      where: { brand_guide_version_id: versionId },
      data: { status: "draft" },
    });

    await writeAudit(
      {
        entityType: "BrandGuideVersion",
        entityId: versionId,
        action: "declined",
        performedById: declinedById,
        details: {
          client_id: existing.client_id,
          version_number: existing.version_number,
          to_status: "draft",
          reason: reason?.trim() || null,
        },
      },
      tx,
    );

    return updated;
  });
}

/** Every version of a client's guide, newest first -- the version history. */
export async function listBrandGuideVersions(
  clientId: string,
  db: Db = prisma,
): Promise<BrandGuideVersionRow[]> {
  return db.brandGuideVersion.findMany({
    where: { client_id: clientId },
    orderBy: { version_number: "desc" },
  });
}

/** One version with its clauses, for the review screen. */
export async function getBrandGuideVersion(
  versionId: string,
  db: Db = prisma,
): Promise<BrandGuideVersionWithClauses> {
  const version = await requireVersion(versionId, db);
  return withClauses(db, version);
}

/** The client a version belongs to, or null -- for scoping a route's check. */
export async function clientOfVersion(versionId: string, db: Db = prisma): Promise<string | null> {
  const row = await db.brandGuideVersion.findUnique({
    where: { brand_guide_version_id: versionId },
    select: { client_id: true },
  });
  return row?.client_id ?? null;
}

/**
 * Clauses from either supported input form, validated.
 *
 * Markdown is parsed with the seed's own parser rather than a second one written
 * here. The clause codes are the citation vocabulary the engine grounds in and
 * `answer_key.json` is graded against, so a guide authored in-app has to produce
 * the same codes a seeded guide does -- two parsers would eventually disagree,
 * and the disagreement would surface as a citation nobody can resolve.
 */
function normalizeClauses(
  input: CreateVersionInput,
  issues: Record<string, string>,
): ClauseInput[] {
  let clauses: ClauseInput[] = [];

  if (Array.isArray(input.clauses) && input.clauses.length > 0) {
    clauses = input.clauses.map((c) => ({
      clause_code: (c?.clause_code ?? "").trim(),
      title: (c?.title ?? "").trim(),
      text: (c?.text ?? "").trim(),
    }));
  } else if (typeof input.markdown === "string" && input.markdown.trim()) {
    clauses = parseClauseLines(input.markdown);
    if (clauses.length === 0) {
      issues.markdown = "No clauses found. Each clause is a line like **CR.4 — Title.** Body.";
      return [];
    }
  } else {
    issues.clauses = "A guide needs its clauses, either as rows or as markdown.";
    return [];
  }

  const seen = new Set<string>();
  for (const c of clauses) {
    if (!c.clause_code) {
      issues.clauses = "Every clause needs a code -- it is what a draft cites.";
      break;
    }
    if (!c.text) {
      issues.clauses = `Clause ${c.clause_code} has no text.`;
      break;
    }
    if (seen.has(c.clause_code)) {
      // The unique index would reject this as a 500. Caught here so the author
      // is told which code is duplicated.
      issues.clauses = `Clause ${c.clause_code} appears twice.`;
      break;
    }
    seen.add(c.clause_code);
  }

  return clauses;
}

type VersionWithContext = BrandGuideVersionRow & {
  /** The version this one would supersede, captured before the update. */
  previously_active_id: string | null;
};

async function requireVersion(versionId: string, db: Db): Promise<VersionWithContext> {
  const version = await db.brandGuideVersion.findUnique({
    where: { brand_guide_version_id: versionId },
  });
  if (!version) throw new BrandGuideNotFoundError(versionId);

  const client = await db.client.findUnique({
    where: { client_id: version.client_id },
    select: { active_brand_guide_id: true },
  });

  return { ...version, previously_active_id: client?.active_brand_guide_id ?? null };
}

async function withClauses(
  db: Db,
  version: BrandGuideVersionRow,
): Promise<BrandGuideVersionWithClauses> {
  const clauses = await db.guidelineClause.findMany({
    where: { brand_guide_version_id: version.brand_guide_version_id },
    orderBy: { clause_code: "asc" },
    select: { clause_id: true, clause_code: true, title: true, text: true },
  });

  return {
    brand_guide_version_id: version.brand_guide_version_id,
    client_id: version.client_id,
    version_number: version.version_number,
    status: version.status,
    created_by_id: version.created_by_id,
    client_approved_by_id: version.client_approved_by_id,
    created_at: version.created_at,
    approved_at: version.approved_at,
    clauses,
  };
}

/**
 * The wire shape of a version. Lives here rather than in a route file because
 * both `/api/brand-guides` and `/api/brand-guides/[id]/approve` answer with it,
 * and a Next route module is an entry point rather than a place to import
 * helpers from.
 */
export function serializeVersion(row: BrandGuideVersionRow) {
  return {
    brand_guide_version_id: row.brand_guide_version_id,
    client_id: row.client_id,
    version_number: row.version_number,
    status: row.status,
    created_by_id: row.created_by_id,
    client_approved_by_id: row.client_approved_by_id,
    created_at: row.created_at.toISOString(),
    approved_at: row.approved_at ? row.approved_at.toISOString() : null,
  };
}

/** The same, with the clauses the version carries -- for a review screen. */
export function serializeVersionWithClauses(row: BrandGuideVersionWithClauses) {
  return { ...serializeVersion(row), clauses: row.clauses };
}
