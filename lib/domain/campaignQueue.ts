import { prisma, type Db } from "../db";
import { clientScopeWhere, type ScopeUser } from "./accessScope";
import {
  DEFAULT_PAGE_SIZE,
  toPage,
  toSkipTake,
  type Page,
  type PageRequest,
} from "./pagination";

/**
 * The incoming queue: briefs that have been submitted, in the order they landed.
 *
 * Scoped through `clientScopeWhere` rather than by a `client_id` the caller
 * passes, for the same reason every other list is: a queue that took its scope
 * from the request would show an account manager another manager's intake by
 * changing one parameter.
 *
 * Separate from `summary.ts`, which counts. This lists -- a manager wants to see
 * *which* brief was flagged, not how many were, and the two questions want
 * different shapes badly enough that sharing one query would serve neither.
 */

/** A row in the queue view. */
export type QueuedCampaign = {
  campaign_id: string;
  client_id: string;
  client_name: string;
  title: string;
  status: string;
  override_attempt_detected: boolean;
  compliance_review_required: boolean;
  created_at: Date;
  /** How the pipeline's output currently stands, for an at-a-glance queue. */
  item_count: number;
  flag_count: number;
};

export type QueueOptions = {
  /** Narrow to one client. Applied *on top of* scope, never instead of it. */
  clientId?: string | null;
  /** Newest first by default -- an intake queue is read from the top. */
  limit?: number;
};

/**
 * The campaigns this user may see.
 *
 * Returns an empty list rather than throwing for a user who may see no clients:
 * `clientScopeWhere` resolves to a filter that matches nothing, so an empty
 * queue is the honest answer and not an error to handle.
 */
export async function campaignQueue(
  user: ScopeUser,
  options: QueueOptions = {},
  db: Db = prisma,
): Promise<QueuedCampaign[]> {
  const scope = await clientScopeWhere(user, db);

  // The requested client is intersected with scope, never substituted for it.
  // Writing `client_id: options.clientId` here instead would be the whole bug:
  // a filter the browser controls would become the only filter applied.
  const where =
    options.clientId != null && options.clientId !== ""
      ? { AND: [scope, { client_id: options.clientId }] }
      : scope;

  const campaigns = await db.campaign.findMany({
    where,
    orderBy: { created_at: "desc" },
    take: options.limit ?? 50,
    select: QUEUE_SELECT,
  });

  return campaigns.map(toQueuedCampaign);
}

/**
 * One select shared by the paged and unpaged queries, so the two cannot drift
 * into returning different columns for the same row type.
 */
const QUEUE_SELECT = {
  campaign_id: true,
  client_id: true,
  title: true,
  status: true,
  override_attempt_detected: true,
  compliance_review_required: true,
  created_at: true,
  client: { select: { name: true } },
  _count: { select: { content_items: true, flags: true } },
} as const;

type QueueRow = {
  campaign_id: string;
  client_id: string;
  title: string;
  status: string;
  override_attempt_detected: boolean;
  compliance_review_required: boolean;
  created_at: Date;
  client: { name: string };
  _count: { content_items: number; flags: number };
};

function toQueuedCampaign(c: QueueRow): QueuedCampaign {
  return {
    campaign_id: c.campaign_id,
    client_id: c.client_id,
    client_name: c.client.name,
    title: c.title,
    status: c.status,
    override_attempt_detected: c.override_attempt_detected,
    compliance_review_required: c.compliance_review_required,
    created_at: c.created_at,
    item_count: c._count.content_items,
    flag_count: c._count.flags,
  };
}

/** What the queue screen can narrow by. */
export type QueueFilters = {
  clientId?: string | null;
  status?: string | null;
  /** Only briefs the engine flagged, or that tried an override. */
  needsAttention?: boolean | null;
  /** Matched against the campaign title. */
  search?: string | null;
};

/**
 * The queue, filtered and paged.
 *
 * The count runs against the same `where` as the rows, so the page indicator
 * cannot disagree with the page.
 */
export async function campaignQueuePaged(
  user: ScopeUser,
  filters: QueueFilters = {},
  page: PageRequest = { page: 1, pageSize: DEFAULT_PAGE_SIZE },
  db: Db = prisma,
): Promise<Page<QueuedCampaign>> {
  const scope = await clientScopeWhere(user, db);

  // Scope first, filters ANDed on top -- never merged, or a filter could
  // overwrite the scope's `client_id` clause and widen the read.
  const conditions: Record<string, unknown>[] = [scope];

  if (filters.clientId) conditions.push({ client_id: filters.clientId });
  if (filters.status) conditions.push({ status: filters.status });

  const search = (filters.search ?? "").trim();
  if (search) conditions.push({ title: { contains: search } });

  if (filters.needsAttention) {
    // What a manager means by "needs attention": the engine raised a flag, or
    // the brief tried to skip a guardrail. Both are recorded, neither is obeyed.
    conditions.push({
      OR: [{ override_attempt_detected: true }, { flags: { some: {} } }],
    });
  }

  const where = { AND: conditions };
  const { skip, take } = toSkipTake(page);

  const [rows, total] = await Promise.all([
    db.campaign.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip,
      take,
      select: QUEUE_SELECT,
    }),
    db.campaign.count({ where }),
  ]);

  return toPage(rows.map(toQueuedCampaign), total, page);
}
