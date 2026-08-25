import { prisma, type Db } from "../db";
import { clientScopeWhere, type ScopeUser } from "./accessScope";
import {
  DEFAULT_PAGE_SIZE,
  toPage,
  toSkipTake,
  type Page,
  type PageRequest,
} from "./pagination";
import { writeAudit } from "./auditLog";
import { isSensitiveSector } from "./sensitiveSector";

/**
 * Reading and creating rows on the client roster.
 *
 * Lives in the domain layer rather than in the route handler because none of
 * this is about HTTP: the scoping, the id allocation, the market validation and
 * the sensitive-sector derivation are all rules, and a rule in a route handler
 * is a rule that the seed, the scheduler, and the next endpoint each re-derive
 * slightly differently. `app/api/clients/route.ts` is a shell over these two
 * functions.
 *
 * Two things are deliberately not decided here:
 *
 *   - **Whether the caller may do this.** `permissions.enforce` answers that,
 *     and the route asks it first. Splitting them means a capability change
 *     lands in one file rather than in every function that happens to write.
 *   - **Which clients the caller sees.** `accessScope.clientScopeWhere` builds
 *     that filter; `listClients` spreads it rather than writing its own `where`.
 */

/** The roster's id format -- human-readable, and referenced by the fixtures. */
const CLIENT_ID_PREFIX = "CL-";
const CLIENT_ID_PATTERN = /^CL-(\d+)$/;

/** Statuses a client may hold. `inactive` gates drafting entirely (Clause 0.6). */
export const CLIENT_STATUSES = ["active", "inactive"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export class ClientValidationError extends Error {
  readonly code = "CLIENT_VALIDATION";
  /** Field-keyed so a form can show each message against its own input. */
  readonly issues: Record<string, string>;

  constructor(issues: Record<string, string>) {
    super(`Invalid client: ${Object.keys(issues).join(", ")}.`);
    this.name = "ClientValidationError";
    this.issues = issues;
  }
}

export type RosterEntry = {
  client_id: string;
  name: string;
  industry: string;
  status: string;
  tier: string | null;
  /** Decoded from the JSON-encoded column -- SQLite has no array type. */
  channels: string[];
  account_manager_id: string | null;
  account_manager_name: string | null;
  active_brand_guide_id: string | null;
  sensitive_sector: boolean;
  /** Every market this client operates in, ordered by country code. */
  markets: { market_id: string; name: string; country_code: string }[];
};

/**
 * The roster, scoped to what this user may see.
 *
 * A user with no visible clients gets an empty list rather than the whole
 * roster: `clientScopeWhere` yields `{ client_id: { in: [] } }` for them, never
 * `{}`. That distinction is the isolation guarantee, and it lives there rather
 * than being re-checked here.
 */
export async function listClients(
  user: ScopeUser,
  db: Db = prisma,
): Promise<RosterEntry[]> {
  const scope = await clientScopeWhere(user, db);

  const rows = await db.client.findMany({
    where: { ...scope },
    orderBy: { client_id: "asc" },
    include: ROSTER_INCLUDE,
  });

  return rows.map(toRosterEntry);
}

/** What the roster screen can narrow by. Every field is optional. */
export type RosterFilters = {
  /** Matched against name and client id, case-insensitively. */
  search?: string | null;
  status?: string | null;
  /** A market id. A client matches if they operate in it. */
  marketId?: string | null;
  /** True for sensitive-sector only, false to exclude them, undefined for both. */
  sensitiveSector?: boolean | null;
};

/**
 * The roster, filtered and paged.
 *
 * Separate from {@link listClients} rather than replacing it, because the two
 * answer different questions: the picker on the brief form wants every client it
 * may submit for, and paging that would silently hide options past the first
 * page. A screen pages; a picker does not.
 *
 * The count runs against the same `where` as the rows, in the same call, so
 * "page 3 of 8" cannot disagree with what page 3 actually holds.
 */
export async function listClientsPaged(
  user: ScopeUser,
  filters: RosterFilters = {},
  page: PageRequest = { page: 1, pageSize: DEFAULT_PAGE_SIZE },
  db: Db = prisma,
): Promise<Page<RosterEntry>> {
  const scope = await clientScopeWhere(user, db);

  // Scope and filters are ANDed, never merged. A filter that overwrote the
  // scope's `client_id` clause would turn a scoped read into an unscoped one --
  // the leak this module exists to prevent.
  const conditions: Record<string, unknown>[] = [scope];

  const search = (filters.search ?? "").trim();
  if (search) {
    // SQLite's LIKE is case-insensitive for ASCII, which is what the client ids
    // and roster names are. No `mode: "insensitive"` -- the SQLite connector
    // does not support it, and passing it silently narrows the match to exact.
    conditions.push({
      OR: [{ name: { contains: search } }, { client_id: { contains: search } }],
    });
  }

  if (filters.status) conditions.push({ status: filters.status });

  if (filters.marketId) {
    conditions.push({ markets: { some: { market_id: filters.marketId } } });
  }

  if (filters.sensitiveSector !== undefined && filters.sensitiveSector !== null) {
    conditions.push({ sensitive_sector: filters.sensitiveSector });
  }

  const where = { AND: conditions };
  const { skip, take } = toSkipTake(page);

  const [rows, total] = await Promise.all([
    db.client.findMany({ where, orderBy: { client_id: "asc" }, skip, take, include: ROSTER_INCLUDE }),
    db.client.count({ where }),
  ]);

  return toPage(rows.map(toRosterEntry), total, page);
}

/** One client, or null when it does not exist or is outside the caller's scope. */
export async function getClient(
  user: ScopeUser,
  clientId: string,
  db: Db = prisma,
): Promise<RosterEntry | null> {
  const scope = await clientScopeWhere(user, db);

  // The scope goes in `AND`, not spread alongside `client_id`. Both filter the
  // same column, and spreading would let the literal id overwrite the scope's
  // `{ in: [...] }` -- silently turning a scoped read into an unscoped one and
  // handing any signed-in user any client they can name. That is the leak this
  // module's scoping exists to prevent, so the two conditions are kept apart
  // rather than merged into one object.
  const row = await db.client.findFirst({
    where: { AND: [scope, { client_id: clientId }] },
    include: ROSTER_INCLUDE,
  });

  return row ? toRosterEntry(row) : null;
}

export type CreateClientInput = {
  name: string;
  industry: string;
  /** At least one, and every one must be a real seeded `Market`. */
  marketIds: string[];
  status?: string;
  tier?: string | null;
  channels?: string[];
  /** Defaults to the creating account manager -- they own the relationship. */
  accountManagerId?: string | null;
  /** Supplied only by a caller restoring a known roster row (the seed, a test). */
  clientId?: string;
};

/**
 * Create a client.
 *
 * `sensitive_sector` is derived, never accepted from the caller. A field a form
 * can set is a field a form can get wrong, and this one decides whether every
 * campaign the client ever runs carries mandatory compliance review -- so it
 * comes from `isSensitiveSector` on the industry, the same function the seed and
 * the engine call.
 *
 * The whole write is one transaction: a client whose `ClientMarket` rows failed
 * to insert would be a client operating in no market, which `resolveOccasions`
 * has no answer for. Either both land or neither does.
 */
export async function createClient(
  input: CreateClientInput,
  createdById: string,
  db: Db = prisma,
): Promise<RosterEntry> {
  const issues: Record<string, string> = {};

  const name = (input.name ?? "").trim();
  if (!name) issues.name = "A client needs a name.";

  const industry = (input.industry ?? "").trim();
  if (!industry) issues.industry = "A client needs an industry.";

  const status = (input.status ?? "active").trim();
  if (!(CLIENT_STATUSES as readonly string[]).includes(status)) {
    issues.status = `Status must be one of ${CLIENT_STATUSES.join(", ")}.`;
  }

  const marketIds = Array.from(new Set(input.marketIds ?? []));
  if (marketIds.length === 0) {
    // PRD 6: an account manager picks one or both at creation. A client with no
    // market has no occasion calendar to plan against at all.
    issues.marketIds = "A client operates in at least one market.";
  }

  if (input.clientId !== undefined && !CLIENT_ID_PATTERN.test(input.clientId)) {
    issues.clientId = `A client id looks like ${CLIENT_ID_PREFIX}101.`;
  }

  if (Object.keys(issues).length > 0) throw new ClientValidationError(issues);

  // Checked against the table rather than an enum: Market is a real table so a
  // third market is a data insert, and a hardcoded list here would silently
  // reject it. This also stops an id the browser invented from reaching the join.
  const known = await db.market.findMany({
    where: { market_id: { in: marketIds } },
    select: { market_id: true },
  });
  if (known.length !== marketIds.length) {
    const found = new Set(known.map((m) => m.market_id));
    throw new ClientValidationError({
      marketIds: `Unknown market(s): ${marketIds.filter((id) => !found.has(id)).join(", ")}.`,
    });
  }

  if (input.accountManagerId) {
    const manager = await db.user.findUnique({
      where: { user_id: input.accountManagerId },
      select: { user_type: true },
    });
    if (!manager || manager.user_type !== "staff") {
      // A client contact as account manager would give a client's own contact
      // the internal reviewer seat by default -- both approval stages, one
      // person.
      throw new ClientValidationError({
        accountManagerId: "An account manager must be an existing staff user.",
      });
    }
  }

  const clientId = input.clientId ?? (await nextClientId(db));

  const created = await db.client.create({
    data: {
      client_id: clientId,
      name,
      industry,
      status,
      tier: input.tier ?? null,
      channels: JSON.stringify(input.channels ?? []),
      account_manager_id:
        input.accountManagerId === undefined ? createdById : input.accountManagerId,
      sensitive_sector: isSensitiveSector(industry),
      markets: { create: marketIds.map((market_id) => ({ market_id })) },
    },
    include: ROSTER_INCLUDE,
  });

  await writeAudit(
    {
      entityType: "Client",
      entityId: clientId,
      action: "created",
      performedById: createdById,
      details: {
        name,
        industry,
        status,
        markets: created.markets.map((m) => m.market.country_code),
        sensitive_sector: created.sensitive_sector,
      },
    },
    db,
  );

  return toRosterEntry(created);
}

/**
 * The next free `CL-###`.
 *
 * Derived from the highest existing id rather than from a row count: the roster
 * starts at CL-101, so a count would collide from the first row. The comparison
 * is numeric in code because the column is text, where "CL-99" sorts after
 * "CL-101".
 */
async function nextClientId(db: Db): Promise<string> {
  const rows = await db.client.findMany({ select: { client_id: true } });

  let highest = 100;
  for (const { client_id } of rows) {
    const match = CLIENT_ID_PATTERN.exec(client_id);
    if (!match) continue;
    const n = Number(match[1]);
    if (n > highest) highest = n;
  }

  return `${CLIENT_ID_PREFIX}${highest + 1}`;
}

const ROSTER_INCLUDE = {
  account_manager: { select: { name: true } },
  markets: {
    include: { market: { select: { market_id: true, name: true, country_code: true } } },
  },
} as const;

type ClientRow = {
  client_id: string;
  name: string;
  industry: string;
  status: string;
  tier: string | null;
  channels: string;
  account_manager_id: string | null;
  active_brand_guide_id: string | null;
  sensitive_sector: boolean;
  account_manager: { name: string } | null;
  markets: { market: { market_id: string; name: string; country_code: string } }[];
};

function toRosterEntry(row: ClientRow): RosterEntry {
  return {
    client_id: row.client_id,
    name: row.name,
    industry: row.industry,
    status: row.status,
    tier: row.tier,
    channels: decodeChannels(row.channels),
    account_manager_id: row.account_manager_id,
    account_manager_name: row.account_manager?.name ?? null,
    active_brand_guide_id: row.active_brand_guide_id,
    sensitive_sector: row.sensitive_sector,
    markets: row.markets
      .map((m) => m.market)
      .sort((a, b) => a.country_code.localeCompare(b.country_code)),
  };
}

/**
 * Channels are a JSON-encoded string in SQLite. A malformed value yields an
 * empty list rather than throwing: one bad row must not make the whole roster
 * unreadable, and the roster screen is where someone would notice and fix it.
 */
function decodeChannels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((c): c is string => typeof c === "string")
      : [];
  } catch {
    return [];
  }
}
