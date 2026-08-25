import { prisma, type Db } from "../db";

/**
 * The one place client visibility is decided.
 *
 * Every scoped query in Phases 4–10 calls this rather than writing its own
 * `where`. That is the point: the PRD's isolation guarantee ("No client's
 * content, drafts, brand guide, or performance data is ever visible to another
 * client's team") is only as strong as its least careful query. Centralising it
 * means the rule is tested once and cannot be forgotten in a new endpoint.
 *
 * Scope is derived from the User row, never from anything the browser sends. A
 * request that carried its own client_id would be asking to be trusted about
 * the very thing being checked.
 */

/** The effective role, derived rather than stored — there is no User.role. */
export type EffectiveRole =
  | "agency_admin"
  | "content_lead"
  | "content_creator"
  | "account_manager"
  | "client_contact";

/** The subset of User this module needs. Anything with these fields will do. */
export type ScopeUser = {
  user_id: string;
  user_type: string;
  is_agency_admin: boolean;
};

/** Roles that see the whole roster. Deliberately short, and deliberately explicit. */
const UNSCOPED_ROLES = new Set<EffectiveRole>(["agency_admin", "content_lead"]);

/**
 * Work out what a user is.
 *
 * Ordering matters. An agency admin is checked first because the flag overrides
 * whatever assignments they happen to hold; a content lead before a creator
 * because someone can be both and the wider scope should win. Getting this
 * backwards would silently narrow a lead to their assignments.
 */
export async function effectiveRole(
  user: ScopeUser,
  db: Db = prisma,
): Promise<EffectiveRole> {
  if (user.user_type === "client_contact") return "client_contact";
  if (user.is_agency_admin) return "agency_admin";

  const assignments = await db.clientAssignment.findMany({
    where: { user_id: user.user_id },
    select: { role_on_client: true },
  });
  const roles = new Set(assignments.map((a) => a.role_on_client));

  if (roles.has("content_lead")) return "content_lead";
  if (roles.has("content_creator")) return "content_creator";

  return "account_manager";
}

/** Whether this role sees every client rather than a subset. */
export function seesAllClients(role: EffectiveRole): boolean {
  return UNSCOPED_ROLES.has(role);
}

export type VisibleClients =
  /** Every client — the content lead and agency admin, whose job is oversight. */
  | { all: true; role: EffectiveRole }
  | { all: false; role: EffectiveRole; clientIds: string[] };

/**
 * Which clients this user may see.
 *
 * - **client contact** — exactly the client they are the approver for. Their
 *   `ClientAssignment` is capped at one row by the single-approver invariant, so
 *   this cannot widen even if a row were added by mistake.
 * - **account manager** — the clients whose `account_manager_id` is them.
 * - **content creator** — the clients they hold an assignment on.
 * - **content lead / agency admin** — all of them. Cross-client visibility is
 *   deliberate for these two and nobody else; `P11.6` tests that.
 *
 * Returns `{ all: true }` rather than 150 ids for the unscoped roles, so a
 * caller builds `where: {}` instead of a `client_id IN (...)` over the whole
 * roster. Collapsing that to an id list would work but would quietly turn every
 * admin query into a 150-item parameter list.
 */
export async function visibleClients(
  user: ScopeUser,
  db: Db = prisma,
): Promise<VisibleClients> {
  const role = await effectiveRole(user, db);

  if (seesAllClients(role)) return { all: true, role };

  if (role === "account_manager") {
    const rows = await db.client.findMany({
      where: { account_manager_id: user.user_id },
      select: { client_id: true },
      orderBy: { client_id: "asc" },
    });
    return { all: false, role, clientIds: rows.map((r) => r.client_id) };
  }

  // Client contact and content creator both scope by assignment; the difference
  // is how many rows they may hold, which the invariant enforces elsewhere.
  const rows = await db.clientAssignment.findMany({
    where: { user_id: user.user_id },
    select: { client_id: true },
    orderBy: { client_id: "asc" },
  });

  return {
    all: false,
    role,
    clientIds: Array.from(new Set(rows.map((r) => r.client_id))),
  };
}

/**
 * The client ids a user may see, always as a list.
 *
 * Convenience for callers that genuinely need the ids. Prefer
 * {@link clientScopeWhere} for building a query — it avoids materialising the
 * whole roster for an admin.
 */
export async function visibleClientIds(
  user: ScopeUser,
  db: Db = prisma,
): Promise<string[]> {
  const scope = await visibleClients(user, db);
  if (!scope.all) return scope.clientIds;

  const rows = await db.client.findMany({
    select: { client_id: true },
    orderBy: { client_id: "asc" },
  });
  return rows.map((r) => r.client_id);
}

/**
 * A Prisma `where` fragment scoping a query on `client_id`.
 *
 * Spread into any query over a client-owned entity:
 *
 *   where: { ...(await clientScopeWhere(user)), status: "drafted" }
 *
 * An unscoped role yields `{}`. A user who may see nothing yields
 * `{ client_id: { in: [] } }`, which matches no rows — **not** `{}`. That
 * distinction is the whole file: an empty scope collapsing to "no filter" would
 * turn a user with no access into a user with total access, which is exactly the
 * failure this centralisation exists to make impossible.
 */
export async function clientScopeWhere(
  user: ScopeUser,
  db: Db = prisma,
): Promise<{ client_id?: { in: string[] } }> {
  const scope = await visibleClients(user, db);
  if (scope.all) return {};

  return { client_id: { in: scope.clientIds } };
}

/** Whether this user may see one specific client. */
export async function canAccessClient(
  user: ScopeUser,
  clientId: string,
  db: Db = prisma,
): Promise<boolean> {
  const scope = await visibleClients(user, db);
  if (scope.all) return true;

  return scope.clientIds.includes(clientId);
}
