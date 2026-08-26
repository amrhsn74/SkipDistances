import { prisma, type Db } from "../db";
import { visibleClientIds, type ScopeUser } from "./accessScope";
import type { BrandGuideVersionRow } from "./brandGuides";

/**
 * A client's guide, as the person who has to approve it reads it.
 *
 * `brandGuides.ts` owns the lifecycle -- draft, submit, approve, supersede. This
 * owns the read behind the screen, and it exists as its own module for the same
 * reason `reviewQueue` does: the questions a review screen asks (what is waiting
 * on me, what changed, what is in force right now) are not the questions the
 * write path asks, and answering them inside the write path would grow it a
 * second responsibility it does not need.
 *
 * Scoped through `visibleClientIds`, so a contact reaches their own client's
 * versions and nothing else. A version id in a URL is intersected with that,
 * never trusted -- a client who edits the address gets their own guide or
 * nothing, never someone else's rules.
 *
 * **What changed** is computed here rather than stored. A version's clauses are
 * rows; the diff against the currently active version is a reading of them, and
 * a stored diff would be a second copy to keep true as clauses are edited.
 */

export type GuideClause = {
  clause_id: string;
  clause_code: string;
  title: string;
  text: string;
};

/** How one clause differs from the guide currently in force. */
export type ClauseChange = "added" | "changed" | "unchanged";

export type ReviewClause = GuideClause & {
  change: ClauseChange;
  /** The wording currently in force, when this clause changes it. */
  previous_text?: string;
};

export type GuideVersionView = BrandGuideVersionRow & {
  clauses: ReviewClause[];
  /** Clause codes the active guide has that this version drops. */
  removed_clause_codes: string[];
  created_by_name: string | null;
  approved_by_name: string | null;
  /** True when this version is the one waiting on the client's decision. */
  awaiting_client: boolean;
};

/**
 * Every version of a client's guide, newest first, with the pending one diffed
 * against whatever is active.
 *
 * Returns an empty list for a client with no guide on file -- the common case,
 * since only 8 of the 150 seeded clients have one. That is not an error: those
 * clients are governed by agency clauses alone, and a screen saying so is more
 * use than one that throws.
 */
export async function guideVersionsForClient(
  user: ScopeUser,
  clientId: string,
  db: Db = prisma,
): Promise<GuideVersionView[]> {
  const scope = await visibleClientIds(user, db);
  if (!scope.includes(clientId)) return [];

  const versions = await db.brandGuideVersion.findMany({
    where: { client_id: clientId },
    orderBy: { version_number: "desc" },
  });

  if (versions.length === 0) return [];

  const clauses = await db.guidelineClause.findMany({
    where: { brand_guide_version_id: { in: versions.map((v) => v.brand_guide_version_id) } },
    orderBy: { clause_code: "asc" },
    select: {
      clause_id: true,
      clause_code: true,
      title: true,
      text: true,
      brand_guide_version_id: true,
    },
  });

  const byVersion = new Map<string, GuideClause[]>();
  for (const clause of clauses) {
    const list = byVersion.get(clause.brand_guide_version_id!) ?? [];
    list.push(clause);
    byVersion.set(clause.brand_guide_version_id!, list);
  }

  // The baseline every other version is read against: what governs this client
  // right now. A pending version's whole meaning is how it differs from this.
  const active = versions.find((v) => v.status === "active");
  const baseline = new Map(
    (active ? byVersion.get(active.brand_guide_version_id) ?? [] : []).map((c) => [
      c.clause_code,
      c,
    ]),
  );

  const names = await namesFor(
    versions.flatMap((v) =>
      [v.created_by_id, v.client_approved_by_id].filter((id): id is string => Boolean(id)),
    ),
    db,
  );

  return versions.map((version) => {
    const own = byVersion.get(version.brand_guide_version_id) ?? [];
    const isActive = version.brand_guide_version_id === active?.brand_guide_version_id;

    return {
      ...version,
      clauses: own.map((clause) => diffClause(clause, baseline, isActive)),
      // Only meaningful for a version being compared against the active one.
      // The active guide cannot "remove" clauses from itself.
      removed_clause_codes: isActive
        ? []
        : [...baseline.keys()].filter((code) => !own.some((c) => c.clause_code === code)),
      created_by_name: version.created_by_id ? names.get(version.created_by_id) ?? null : null,
      approved_by_name: version.client_approved_by_id
        ? names.get(version.client_approved_by_id) ?? null
        : null,
      awaiting_client: version.status === "pending_client_approval",
    };
  });
}

/**
 * How one clause stands against the guide in force.
 *
 * The active version's own clauses are reported `unchanged` rather than diffed
 * against themselves -- comparing a version to itself would mark every clause
 * "changed" the moment the map lookup found the same row.
 */
function diffClause(
  clause: GuideClause,
  baseline: Map<string, GuideClause>,
  isActive: boolean,
): ReviewClause {
  if (isActive) return { ...clause, change: "unchanged" };

  const previous = baseline.get(clause.clause_code);
  if (!previous) return { ...clause, change: "added" };
  if (previous.text.trim() !== clause.text.trim() || previous.title.trim() !== clause.title.trim()) {
    return { ...clause, change: "changed", previous_text: previous.text };
  }
  return { ...clause, change: "unchanged" };
}

async function namesFor(userIds: string[], db: Db): Promise<Map<string, string>> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return new Map();

  const users = await db.user.findMany({
    where: { user_id: { in: unique } },
    select: { user_id: true, name: true },
  });

  return new Map(users.map((u) => [u.user_id, u.name]));
}

/** A version view, ready to cross into a client component. */
export function serializeGuideVersion(version: GuideVersionView) {
  return {
    brand_guide_version_id: version.brand_guide_version_id,
    client_id: version.client_id,
    version_number: version.version_number,
    status: version.status,
    created_at: version.created_at.toISOString(),
    approved_at: version.approved_at ? version.approved_at.toISOString() : null,
    created_by_name: version.created_by_name,
    approved_by_name: version.approved_by_name,
    awaiting_client: version.awaiting_client,
    clauses: version.clauses,
    removed_clause_codes: version.removed_clause_codes,
  };
}

export type GuideVersionSerialized = ReturnType<typeof serializeGuideVersion>;
