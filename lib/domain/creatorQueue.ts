import { prisma, type Db } from "../db";
import { clientScopeWhere, type ScopeUser } from "./accessScope";
import {
  DEFAULT_PAGE_SIZE,
  toPage,
  toSkipTake,
  type Page,
  type PageRequest,
} from "./pagination";
import type { ContentStatus } from "./statusMachine";

/**
 * What a creator has in front of them.
 *
 * Separate from `reviewQueue` because it is a different question, not a
 * different filter on the same one. A reviewer asks "what is waiting on my
 * decision"; a creator asks "what is mine to work on" -- and the answer is the
 * statuses *before* review plus everything that came back, which is precisely
 * the complement of a reviewer's list. Sharing one query with a status parameter
 * would produce a function whose name told a reader nothing about which it was.
 *
 * Scoped through `clientScopeWhere`, which for a creator resolves to their
 * `ClientAssignment` rows. That is the whole of P7.1's "scoped via
 * ClientAssignment": there is no second scoping rule here, because a second
 * rule is a second thing that can be wrong.
 */

/**
 * The statuses a creator owns.
 *
 * `drafted` and `in_refinement` are work in progress. `flagged` is work the
 * engine refused and someone has to fix. `pending_internal_review` stays visible
 * -- a creator who submitted something an hour ago should be able to see where
 * it went, and a list that dropped it at the moment of submission would make the
 * screen look like work vanishing.
 *
 * Deliberately not `published` or `publish_failed`: neither is a creator's to
 * act on, and `publish_failed` in particular belongs to whoever can retry a
 * publish, which a creator cannot.
 */
const CREATOR_STATUSES: readonly ContentStatus[] = [
  "drafted",
  "in_refinement",
  "flagged",
  "pending_internal_review",
];

/** Statuses where the item is genuinely the creator's to change. */
const EDITABLE: readonly ContentStatus[] = ["drafted", "in_refinement", "flagged"];

export type CreatorItem = {
  content_item_id: string;
  campaign_id: string;
  campaign_title: string;
  client_id: string;
  client_name: string;
  content_form: string;
  platform: string | null;
  content_body: string | null;
  status: ContentStatus;
  market_name: string | null;
  created_at: Date;
  updated_at: Date;
  citations: { clause_id: string; clause_code: string; title: string; source_type: string }[];
  /** The rule the engine flagged this on, where it flagged one. */
  flagged_clause: { clause_code: string; title: string; text: string } | null;
  /** How many reference files have been attached across every regeneration. */
  reference_count: number;
  /**
   * Whether this item is the creator's to change right now. False once it is in
   * review: the screen still shows it, but editing it under the reviewer would
   * silently reset a decision they are in the middle of making.
   */
  editable: boolean;
};

export type CreatorFilters = {
  clientId?: string | null;
  status?: string | null;
  /** Only what the engine refused -- the work that most needs a human. */
  flaggedOnly?: boolean | null;
  search?: string | null;
};

export async function creatorQueue(
  user: ScopeUser,
  filters: CreatorFilters = {},
  page: PageRequest = { page: 1, pageSize: DEFAULT_PAGE_SIZE },
  db: Db = prisma,
): Promise<Page<CreatorItem>> {
  const scope = await clientScopeWhere(user, db);

  // A requested status is intersected with the creator's own set rather than
  // replacing it, for the same reason as in the review queue: a filter the
  // browser controls must only narrow what the role already permits.
  const requested = (filters.status ?? "").trim();
  const statuses =
    requested && (CREATOR_STATUSES as readonly string[]).includes(requested)
      ? [requested]
      : [...CREATOR_STATUSES];

  const conditions: Record<string, unknown>[] = [
    { campaign: { is: scope } },
    { status: filters.flaggedOnly ? "flagged" : { in: statuses } },
  ];

  if (filters.clientId) conditions.push({ campaign: { is: { client_id: filters.clientId } } });

  const search = (filters.search ?? "").trim();
  if (search) conditions.push({ campaign: { is: { title: { contains: search } } } });

  const where = { AND: conditions };
  const { skip, take } = toSkipTake(page);

  const [rows, total] = await Promise.all([
    db.contentItem.findMany({
      where,
      // Most recently touched first. A creator returns to what they were last
      // working on, unlike a reviewer working a pile from the bottom.
      orderBy: [{ updated_at: "desc" }],
      skip,
      take,
      select: CREATOR_SELECT,
    }),
    db.contentItem.count({ where }),
  ]);

  const clauseIds = new Set<string>();
  for (const row of rows) {
    if (row.flagged_clause_id) clauseIds.add(row.flagged_clause_id);
  }

  const [citations, clauses] = await Promise.all([
    citationsFor(rows.map((r) => r.content_item_id), db),
    clausesById([...clauseIds], db),
  ]);

  return toPage(
    rows.map((row) => {
      const status = row.status as ContentStatus;
      return {
        content_item_id: row.content_item_id,
        campaign_id: row.campaign_id,
        campaign_title: row.campaign.title,
        client_id: row.campaign.client_id,
        client_name: row.campaign.client.name,
        content_form: row.content_form,
        platform: row.platform,
        content_body: row.content_body,
        status,
        market_name: row.market?.name ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        citations: citations.get(row.content_item_id) ?? [],
        flagged_clause: row.flagged_clause_id
          ? clauses.get(row.flagged_clause_id) ?? null
          : null,
        reference_count: row._count.references,
        editable: EDITABLE.includes(status),
      };
    }),
    total,
    page,
  );
}

const CREATOR_SELECT = {
  content_item_id: true,
  campaign_id: true,
  content_form: true,
  platform: true,
  content_body: true,
  status: true,
  flagged_clause_id: true,
  created_at: true,
  updated_at: true,
  campaign: { select: { title: true, client_id: true, client: { select: { name: true } } } },
  market: { select: { name: true } },
  _count: { select: { references: true } },
} as const;

/**
 * The clauses cited by each item.
 *
 * Two queries rather than a join: `ContentItemCitation` carries a bare
 * `clause_id` with no declared relation, as the ERD models it.
 */
async function citationsFor(contentItemIds: string[], db: Db) {
  const byItem = new Map<
    string,
    { clause_id: string; clause_code: string; title: string; source_type: string }[]
  >();
  if (contentItemIds.length === 0) return byItem;

  const links = await db.contentItemCitation.findMany({
    where: { content_item_id: { in: contentItemIds } },
    select: { content_item_id: true, clause_id: true },
  });
  if (links.length === 0) return byItem;

  const clauses = await db.guidelineClause.findMany({
    where: { clause_id: { in: [...new Set(links.map((l) => l.clause_id))] } },
    select: { clause_id: true, clause_code: true, title: true, source_type: true },
  });
  const byId = new Map(clauses.map((c) => [c.clause_id, c]));

  for (const link of links) {
    const clause = byId.get(link.clause_id);
    if (!clause) continue;
    const list = byItem.get(link.content_item_id) ?? [];
    list.push(clause);
    byItem.set(link.content_item_id, list);
  }

  for (const list of byItem.values()) {
    list.sort(
      (a, b) =>
        a.source_type.localeCompare(b.source_type) || a.clause_code.localeCompare(b.clause_code),
    );
  }

  return byItem;
}

/**
 * The full text of the flagged clauses in this page.
 *
 * Text, not just the code, because this is the one place it is genuinely needed:
 * a creator fixing a flagged draft has to know what the rule actually says, and
 * sending them elsewhere to look up `1.3` is how a flag gets worked around
 * instead of addressed.
 */
async function clausesById(clauseIds: string[], db: Db) {
  if (clauseIds.length === 0) {
    return new Map<string, { clause_code: string; title: string; text: string }>();
  }

  const rows = await db.guidelineClause.findMany({
    where: { clause_id: { in: clauseIds } },
    select: { clause_id: true, clause_code: true, title: true, text: true },
  });

  return new Map(rows.map((r) => [r.clause_id, r]));
}

/** A creator row, ready to cross into a client component. */
export function serializeCreatorItem(item: CreatorItem) {
  return {
    content_item_id: item.content_item_id,
    campaign_id: item.campaign_id,
    campaign_title: item.campaign_title,
    client_id: item.client_id,
    client_name: item.client_name,
    content_form: item.content_form,
    platform: item.platform,
    content_body: item.content_body,
    status: item.status as string,
    market_name: item.market_name,
    created_at: item.created_at.toISOString(),
    updated_at: item.updated_at.toISOString(),
    citations: item.citations,
    flagged_clause: item.flagged_clause,
    reference_count: item.reference_count,
    editable: item.editable,
  };
}

export type CreatorItemSerialized = ReturnType<typeof serializeCreatorItem>;

/**
 * The creator's overview counts, and their clients.
 *
 * A different question from `creatorQueue`, which lists rows. This one answers
 * "what needs me", and the distinction it draws is the point: `flagged`,
 * `inProgress` and `assigned` are work stuck on this person, while
 * `awaitingReview` is work they have already handed on. A panel that summed all
 * four into one "your work" number would tell a creator to act on something that
 * is somebody else's move.
 *
 * Scoped through `clientScopeWhere`, the same call the queue makes -- so the
 * overview and the list it links into cannot disagree about what is in scope.
 */
export type CreatorOverviewData = {
  counts: {
    flagged: number;
    inProgress: number;
    assigned: number;
    awaitingReview: number;
  };
  clients: {
    client_id: string;
    name: string;
    inProgress: number;
    flagged: number;
  }[];
};

/** Statuses a creator still has to act on, as opposed to wait on. */
const IN_PROGRESS: readonly ContentStatus[] = ["drafted", "in_refinement"];

export async function creatorOverview(
  user: ScopeUser,
  db: Db = prisma,
): Promise<CreatorOverviewData> {
  const scope = await clientScopeWhere(user, db);
  const mine = { campaign: { is: scope } };

  const [flagged, inProgress, assigned, awaitingReview, byClient, clients] = await Promise.all([
    db.contentItem.count({ where: { ...mine, status: "flagged" } }),
    db.contentItem.count({ where: { ...mine, status: { in: [...IN_PROGRESS] } } }),
    // Handed over by a lead and not yet submitted. Counted on `assigned_to_id`
    // rather than on scope, because this is the one number that is about *this
    // person* rather than about their clients.
    db.contentItem.count({
      where: {
        ...mine,
        assigned_to_id: user.user_id,
        status: { in: [...IN_PROGRESS, "flagged"] },
      },
    }),
    db.contentItem.count({ where: { ...mine, status: "pending_internal_review" } }),
    db.contentItem.groupBy({
      by: ["campaign_id", "status"],
      where: { ...mine, status: { in: [...IN_PROGRESS, "flagged"] } },
      _count: { _all: true },
    }),
    db.client.findMany({
      where: scope,
      select: { client_id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  // `groupBy` can only group by a column on the row itself, so the campaign ids
  // are resolved to clients in a second pass rather than by loading every item.
  const campaigns = await db.campaign.findMany({
    where: { campaign_id: { in: byClient.map((row) => row.campaign_id) } },
    select: { campaign_id: true, client_id: true },
  });
  const clientOfCampaign = new Map(campaigns.map((c) => [c.campaign_id, c.client_id]));

  const tally = new Map<string, { inProgress: number; flagged: number }>();
  for (const row of byClient) {
    const clientId = clientOfCampaign.get(row.campaign_id);
    if (!clientId) continue;
    const entry = tally.get(clientId) ?? { inProgress: 0, flagged: 0 };
    if (row.status === "flagged") entry.flagged += row._count._all;
    else entry.inProgress += row._count._all;
    tally.set(clientId, entry);
  }

  return {
    counts: { flagged, inProgress, assigned, awaitingReview },
    clients: clients.map((client) => ({
      client_id: client.client_id,
      name: client.name,
      inProgress: tally.get(client.client_id)?.inProgress ?? 0,
      flagged: tally.get(client.client_id)?.flagged ?? 0,
    })),
  };
}
