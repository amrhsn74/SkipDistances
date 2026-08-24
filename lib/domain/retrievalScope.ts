import { prisma, type Db } from "../db";

/**
 * Clause 0.4 — Ground everything in the client's brand guide.
 * Clause 0.7 — One client's information stays with that client.
 *
 * The retrieval scope for drafting: a request can only ever return the
 * requesting client's own ACTIVE brand guide version plus the agency standards.
 *
 * This is the architecture's "structurally impossible rather than a matter of
 * model behaviour" guarantee (§4). The scoping lives in the query, so no prompt
 * wording, reference file, or client comment can widen it -- there is no code
 * path that returns another client's clauses, regardless of what is asked for.
 */

export type ScopedClause = {
  clause_id: string;
  clause_code: string;
  title: string;
  text: string;
  source_type: "agency" | "brand";
};

export type GuidelineScope = {
  clientId: string;
  /** Null when the client has no guide on file -- the majority of the roster. */
  brandGuideVersionId: string | null;
  agency: ScopedClause[];
  brand: ScopedClause[];
  /** Agency + brand, the full set the engine grounds a draft in. */
  all: ScopedClause[];
};

export async function getGuidelinesForClient(
  clientId: string,
  db: Db = prisma,
): Promise<GuidelineScope> {
  // Agency standards are global and unversioned: they govern every client,
  // including the 142 with no brand guide of their own.
  const agencyRows = await db.guidelineClause.findMany({
    where: { source_type: "agency" },
    orderBy: { clause_code: "asc" },
  });

  const client = await db.client.findUnique({
    where: { client_id: clientId },
    select: { active_brand_guide_id: true },
  });

  const activeGuideId = client?.active_brand_guide_id ?? null;

  // Scoped twice on purpose: by the client's own active guide id, AND by that
  // guide belonging to this client. Either alone would be enough today; both
  // together mean a stale or mis-set active_brand_guide_id still cannot reach
  // into another client's rules.
  const brandRows = activeGuideId
    ? await db.guidelineClause.findMany({
        where: {
          source_type: "brand",
          brand_guide_version_id: activeGuideId,
          brand_guide_version: { client_id: clientId },
        },
        orderBy: { clause_code: "asc" },
      })
    : [];

  const agency = agencyRows.map(toScoped);
  const brand = brandRows.map(toScoped);

  return {
    clientId,
    brandGuideVersionId: activeGuideId,
    agency,
    brand,
    all: [...agency, ...brand],
  };
}

type ClauseRow = {
  clause_id: string;
  clause_code: string;
  title: string;
  text: string;
  source_type: string;
};

function toScoped(row: ClauseRow): ScopedClause {
  return {
    clause_id: row.clause_id,
    clause_code: row.clause_code,
    title: row.title,
    text: row.text,
    source_type: row.source_type === "agency" ? "agency" : "brand",
  };
}

/**
 * Resolves a clause the engine cited, scoped to what that client could actually
 * see. A citation naming a clause outside the client's scope resolves to null
 * rather than silently succeeding -- the check behind the Phase 12
 * cross-client isolation test.
 */
export async function resolveCitedClause(
  clientId: string,
  clauseCode: string,
  db: Db = prisma,
): Promise<ScopedClause | null> {
  const scope = await getGuidelinesForClient(clientId, db);
  return scope.all.find((c) => c.clause_code === clauseCode) ?? null;
}
