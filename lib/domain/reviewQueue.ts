import { prisma, type Db } from "../db";
import { clientScopeWhere, type ScopeUser } from "./accessScope";
import { currentDecisions, type DecisionRow } from "./gate";
import {
  DEFAULT_PAGE_SIZE,
  toPage,
  toSkipTake,
  type Page,
  type PageRequest,
} from "./pagination";
import type { ApprovalStage, ContentStatus } from "./statusMachine";

/**
 * What a reviewer is looking at.
 *
 * The two-stage review screen is one screen serving two stages, so this is one
 * query taking a stage rather than two queries that would have to be kept
 * agreeing about what "awaiting me" means. The internal reviewer and the client
 * ask structurally identical questions -- which of the items I can see are at a
 * status my stage acts on -- and the only thing that differs is which statuses
 * those are.
 *
 * **The stage is never read from the request.** A caller passes it, and every
 * caller derives it from the signed-in user's role. A `?stage=` parameter would
 * let a client contact list the internal queue, and worse, would make the screen
 * they were shown disagree with the capability the approvals endpoint then
 * checks -- an approve button that always answers 403.
 *
 * Scoped through `clientScopeWhere` like every other list. A content lead sees
 * every client because that is their role; an account manager sees the ones they
 * manage; a client contact sees one. None of that is decided here.
 */

/**
 * The statuses each stage acts on.
 *
 * Both lists deliberately include the *already decided* statuses, not just the
 * pending one. A reviewer who approved something an hour ago and now wants it
 * back has to be able to find it, and the late-revoke this phase builds is
 * meaningless if the only way to reach an approved item is a URL nobody kept.
 *
 * The client's list runs one status further, through `scheduled`: an item with a
 * date booked is still the client's to pull back, right up until it publishes.
 */
const STAGE_STATUSES: Record<ApprovalStage, readonly ContentStatus[]> = {
  internal: ["pending_internal_review", "internal_approved"],
  client: ["pending_client_review", "client_approved", "scheduled"],
};

/** The status at which this stage's decision is the one being waited on. */
const AWAITING_STATUS: Record<ApprovalStage, ContentStatus> = {
  internal: "pending_internal_review",
  client: "pending_client_review",
};

/** Statuses at which a decline is pulling back an approval already given. */
const ALREADY_APPROVED: readonly ContentStatus[] = [
  "internal_approved",
  "client_approved",
  "scheduled",
];

/** One message on an item's thread. */
export type ItemComment = {
  comment_id: string;
  author_id: string | null;
  author_name: string | null;
  body: string;
  created_at: Date;
};

/** One clause a drafted item was written under. */
export type ItemCitation = {
  clause_id: string;
  clause_code: string;
  title: string;
  source_type: string;
};

/**
 * A standing decision, with the decider's name resolved.
 *
 * The gate returns `decided_by_id`, which is all the gate needs. A review screen
 * needs the name: "approved by Rana Fouad" is what makes a revoke a considered
 * act, and an opaque id would send a reviewer to another screen to find out
 * whose approval they are about to pull back.
 */
export type NamedDecision = DecisionRow & { decided_by_name: string | null };

export type ReviewDecisions = {
  internal: NamedDecision | null;
  client: NamedDecision | null;
};

/** A row on the review screen. */
export type ReviewItem = {
  content_item_id: string;
  campaign_id: string;
  campaign_title: string;
  client_id: string;
  client_name: string;
  content_form: string;
  platform: string | null;
  content_body: string | null;
  status: ContentStatus;
  scheduled_date: Date | null;
  market_name: string | null;
  created_at: Date;
  /**
   * The rules this item was written under -- the "why, not just what" the PRD
   * asks a reviewer to be able to see. An item with no citations is shown with
   * none rather than hidden: a draft that cites nothing is exactly what a
   * reviewer should notice.
   */
  citations: ItemCitation[];
  /** How many messages are on this item's thread, for the comment affordance. */
  comment_count: number;
  /**
   * The thread itself. Carried on the row so the screen can open a conversation
   * without a second round trip -- and, more to the point, so posting into it
   * needs no page refresh: a comment changes nothing about the item, and
   * re-reading the page after one would imply it had.
   */
  comments: ItemComment[];
  /**
   * The latest decision per stage, as the gate reads them. Carried on the row so
   * the screen can say "waiting on the client" without a second round trip --
   * and so an approved item shows *who* approved it, which is what makes a
   * revoke a considered action rather than a guess.
   */
  decisions: ReviewDecisions;
  /** True when this stage's decision is the one currently outstanding. */
  awaiting_me: boolean;
  /**
   * True when a decision here would pull back an approval already given. Drives
   * the confirmation state in `P6.4`; the domain consequence is identical either
   * way, which is the whole point of the symmetric late-revoke.
   */
  late_revoke: boolean;
};

export type ReviewFilters = {
  /** Narrow to one client. Applied *on top of* scope, never instead of it. */
  clientId?: string | null;
  /** Narrow to one status within the stage's own set. */
  status?: string | null;
  /** Only what is actually waiting on this stage. */
  awaitingOnly?: boolean | null;
  /** Matched against the campaign title. */
  search?: string | null;
};

/**
 * The items this user may review at this stage, filtered and paged.
 *
 * The count runs against the same `where` as the rows, so the page indicator
 * cannot disagree with the page.
 */
export async function reviewQueue(
  user: ScopeUser,
  stage: ApprovalStage,
  filters: ReviewFilters = {},
  page: PageRequest = { page: 1, pageSize: DEFAULT_PAGE_SIZE },
  db: Db = prisma,
): Promise<Page<ReviewItem>> {
  const scope = await clientScopeWhere(user, db);

  const statuses = STAGE_STATUSES[stage];

  // A requested status is intersected with the stage's own set rather than
  // replacing it. Substituting would let `?status=published` list items this
  // stage has no business acting on -- a filter the browser controls must only
  // ever narrow what the role already permits.
  const requested = (filters.status ?? "").trim();
  const statusFilter =
    requested && (statuses as readonly string[]).includes(requested) ? [requested] : [...statuses];

  const conditions: Record<string, unknown>[] = [
    { campaign: { is: scope } },
    { status: filters.awaitingOnly ? AWAITING_STATUS[stage] : { in: statusFilter } },
  ];

  if (filters.clientId) conditions.push({ campaign: { is: { client_id: filters.clientId } } });

  const search = (filters.search ?? "").trim();
  if (search) conditions.push({ campaign: { is: { title: { contains: search } } } });

  const where = { AND: conditions };
  const { skip, take } = toSkipTake(page);

  const [rows, total] = await Promise.all([
    db.contentItem.findMany({
      where,
      // Oldest first, unlike the intake queue. A review list is worked through
      // from the bottom of the pile: the item that has been waiting longest is
      // the one holding up a campaign, and newest-first would bury it.
      orderBy: [{ created_at: "asc" }],
      skip,
      take,
      select: REVIEW_SELECT,
    }),
    db.contentItem.count({ where }),
  ]);

  const ids = rows.map((r) => r.content_item_id);
  const [citations, decisions, comments] = await Promise.all([
    citationsFor(ids, db),
    decisionsFor(ids, db),
    commentsFor(ids, db),
  ]);

  return toPage(
    rows.map((row) => toReviewItem(row, stage, citations, decisions, comments)),
    total,
    page,
  );
}

/** One item, with everything the review screen shows -- or null if out of scope. */
export async function reviewItem(
  user: ScopeUser,
  stage: ApprovalStage,
  contentItemId: string,
  db: Db = prisma,
): Promise<ReviewItem | null> {
  const scope = await clientScopeWhere(user, db);

  const row = await db.contentItem.findFirst({
    where: { content_item_id: contentItemId, campaign: { is: scope } },
    select: REVIEW_SELECT,
  });

  if (!row) return null;

  const [citations, decisions, comments] = await Promise.all([
    citationsFor([row.content_item_id], db),
    decisionsFor([row.content_item_id], db),
    commentsFor([row.content_item_id], db),
  ]);

  return toReviewItem(row, stage, citations, decisions, comments);
}

const REVIEW_SELECT = {
  content_item_id: true,
  campaign_id: true,
  content_form: true,
  platform: true,
  content_body: true,
  status: true,
  scheduled_date: true,
  created_at: true,
  campaign: { select: { title: true, client_id: true, client: { select: { name: true } } } },
  market: { select: { name: true } },
  _count: { select: { comments: true } },
} as const;

type ReviewRow = {
  content_item_id: string;
  campaign_id: string;
  content_form: string;
  platform: string | null;
  content_body: string | null;
  status: string;
  scheduled_date: Date | null;
  created_at: Date;
  campaign: { title: string; client_id: string; client: { name: string } };
  market: { name: string } | null;
  _count: { comments: number };
};

function toReviewItem(
  row: ReviewRow,
  stage: ApprovalStage,
  citations: Map<string, ItemCitation[]>,
  decisions: Map<string, ReviewDecisions>,
  comments: Map<string, ItemComment[]>,
): ReviewItem {
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
    scheduled_date: row.scheduled_date,
    market_name: row.market?.name ?? null,
    created_at: row.created_at,
    citations: citations.get(row.content_item_id) ?? [],
    comment_count: row._count.comments,
    comments: comments.get(row.content_item_id) ?? [],
    decisions: decisions.get(row.content_item_id) ?? { internal: null, client: null },
    awaiting_me: status === AWAITING_STATUS[stage],
    late_revoke: ALREADY_APPROVED.includes(status),
  };
}

/**
 * The clauses cited by each of these items.
 *
 * Two queries rather than a join, because `ContentItemCitation` carries a bare
 * `clause_id` with no relation declared to `GuidelineClause` -- the ERD models
 * it as a plain column, and inventing a relation here to save a round trip would
 * put a schema change inside a read.
 *
 * Batched across the whole page. Resolving citations per row is the N+1 that
 * turns a twenty-item review screen into forty-one queries.
 */
async function citationsFor(
  contentItemIds: string[],
  db: Db,
): Promise<Map<string, ItemCitation[]>> {
  const byItem = new Map<string, ItemCitation[]>();
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

  const clauseById = new Map(clauses.map((c) => [c.clause_id, c]));

  for (const link of links) {
    const clause = clauseById.get(link.clause_id);
    if (!clause) continue;
    const list = byItem.get(link.content_item_id) ?? [];
    list.push(clause);
    byItem.set(link.content_item_id, list);
  }

  // Agency clauses before brand ones, then by code, so a reviewer reads the same
  // order on every row rather than whatever the database happened to return.
  for (const list of byItem.values()) {
    list.sort(
      (a, b) =>
        a.source_type.localeCompare(b.source_type) || a.clause_code.localeCompare(b.clause_code),
    );
  }

  return byItem;
}

/**
 * The current decisions for each item, read through the gate itself.
 *
 * Calling `currentDecisions` rather than reimplementing its ordering is the
 * point: the review screen must show exactly what the gate would see, and a
 * second most-recent-per-stage query written here is how a screen ends up
 * claiming an item is approved that the gate then refuses to schedule.
 *
 * Names are resolved in one batched query afterwards rather than joined into the
 * gate's own read, which stays deliberately narrow -- the gate has no business
 * knowing what a user is called.
 */
async function decisionsFor(
  contentItemIds: string[],
  db: Db,
): Promise<Map<string, ReviewDecisions>> {
  const raw = await Promise.all(
    contentItemIds.map(async (id) => [id, await currentDecisions(id, db)] as const),
  );

  const deciderIds = new Set<string>();
  for (const [, decisions] of raw) {
    for (const row of [decisions.internal, decisions.client]) {
      if (row?.decided_by_id) deciderIds.add(row.decided_by_id);
    }
  }

  const names = await namesFor([...deciderIds], db);

  const named = (row: DecisionRow | null): NamedDecision | null =>
    row === null
      ? null
      : { ...row, decided_by_name: row.decided_by_id ? names.get(row.decided_by_id) ?? null : null };

  return new Map(
    raw.map(([id, decisions]) => [
      id,
      { internal: named(decisions.internal), client: named(decisions.client) },
    ]),
  );
}

/**
 * The thread on each of these items, oldest first.
 *
 * Batched with the page for the same reason citations are. Reading a thread is
 * the one place a review screen touches `Comment` at all -- and it stays a read:
 * nothing in this module writes one, and nothing about a comment feeds the
 * status or the gate.
 */
async function commentsFor(
  contentItemIds: string[],
  db: Db,
): Promise<Map<string, ItemComment[]>> {
  const byItem = new Map<string, ItemComment[]>();
  if (contentItemIds.length === 0) return byItem;

  const rows = await db.comment.findMany({
    where: { content_item_id: { in: contentItemIds } },
    orderBy: { created_at: "asc" },
    select: {
      comment_id: true,
      content_item_id: true,
      author_id: true,
      body: true,
      created_at: true,
      author: { select: { name: true } },
    },
  });

  for (const row of rows) {
    const list = byItem.get(row.content_item_id!) ?? [];
    list.push({
      comment_id: row.comment_id,
      author_id: row.author_id,
      author_name: row.author?.name ?? null,
      body: row.body,
      created_at: row.created_at,
    });
    byItem.set(row.content_item_id!, list);
  }

  return byItem;
}

/** Display names for a set of user ids. */
async function namesFor(userIds: string[], db: Db): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();

  const users = await db.user.findMany({
    where: { user_id: { in: userIds } },
    select: { user_id: true, name: true },
  });

  return new Map(users.map((u) => [u.user_id, u.name]));
}

/**
 * A review row, ready to cross into a client component.
 *
 * Here rather than in the page so three routes cannot each invent their own
 * date format or drop a field. Dates become ISO strings because that is what a
 * `Date` becomes across the boundary anyway -- doing it explicitly is what keeps
 * the client-side type honest about what it is receiving.
 */
export function serializeReviewItem(item: ReviewItem) {
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
    scheduled_date: item.scheduled_date?.toISOString() ?? null,
    market_name: item.market_name,
    created_at: item.created_at.toISOString(),
    citations: item.citations,
    comment_count: item.comment_count,
    comments: item.comments.map((c) => ({
      comment_id: c.comment_id,
      author_id: c.author_id,
      author_name: c.author_name,
      body: c.body,
      created_at: c.created_at.toISOString(),
    })),
    decisions: {
      internal: serializeDecision(item.decisions.internal),
      client: serializeDecision(item.decisions.client),
    },
    awaiting_me: item.awaiting_me,
    late_revoke: item.late_revoke,
  };
}

function serializeDecision(decision: NamedDecision | null) {
  if (decision === null) return null;
  return {
    decision: decision.decision,
    comment: decision.comment,
    decided_at: decision.decided_at.toISOString(),
    // Carried alongside the name so the screen can show a face. The gate has no
    // use for either -- this is the review layer adding what a human needs.
    decided_by_id: decision.decided_by_id,
    decided_by_name: decision.decided_by_name,
  };
}
