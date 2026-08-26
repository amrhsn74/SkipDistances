import { prisma, type Db } from "../db";
import { clientScopeWhere, type ScopeUser } from "./accessScope";
import { METRIC_TYPES, type MetricType } from "../instagram/insights";

/**
 * Performance, scoped by who is asking.
 *
 * `P10.2` and `P10.3` are the same query with different scope -- the account
 * manager sees their assigned clients, the client sees their own account -- so
 * this is one function taking a `ScopeUser` rather than two that could disagree.
 * `P10.4` is the test that the difference is real.
 *
 * The scope comes from `clientScopeWhere`, the same call every other read layer
 * makes. Not a `clientId` parameter: an endpoint that took the client from the
 * caller would be one query string away from showing a client somebody else's
 * numbers, and no amount of UI care would fix that.
 *
 * `MetricSnapshot` is a time series -- one row per metric per poll -- so "current
 * value" is the latest row rather than a mutable field. That is what lets the
 * views show whether a post is still growing, and it is why these queries read
 * the most recent snapshot per (item, metric) rather than summing.
 */

export type ItemPerformance = {
  content_item_id: string;
  client_id: string;
  client_name: string;
  campaign_title: string;
  content_form: string;
  platform: string | null;
  published_at: Date | null;
  metrics: Record<MetricType, number>;
  /** When the numbers were last polled -- so a stale view says so. */
  captured_at: Date | null;
};

export type PerformanceSummary = {
  items: ItemPerformance[];
  totals: Record<MetricType, number>;
  /** Published items in scope with no snapshot yet. */
  awaitingFirstPoll: number;
};

const EMPTY: Record<MetricType, number> = {
  impressions: 0,
  reach: 0,
  likes: 0,
  comments: 0,
  shares: 0,
  saves: 0,
};

export async function performanceFor(
  user: ScopeUser,
  db: Db = prisma,
): Promise<PerformanceSummary> {
  const scope = await clientScopeWhere(user, db);

  const items = await db.contentItem.findMany({
    where: { status: "published", campaign: { is: scope } },
    orderBy: { updated_at: "desc" },
    select: {
      content_item_id: true,
      content_form: true,
      platform: true,
      updated_at: true,
      campaign: {
        select: { title: true, client: { select: { client_id: true, name: true } } },
      },
    },
  });

  if (items.length === 0) {
    return { items: [], totals: { ...EMPTY }, awaitingFirstPoll: 0 };
  }

  const itemIds = items.map((item) => item.content_item_id);

  // Every snapshot for these items, newest first. The latest per (item, metric)
  // is taken in one pass below rather than with a correlated subquery per
  // metric -- six metrics across a page of items would otherwise be dozens of
  // round trips.
  const snapshots = await db.metricSnapshot.findMany({
    where: { content_item_id: { in: itemIds } },
    orderBy: { captured_at: "desc" },
    select: {
      content_item_id: true,
      metric_type: true,
      value: true,
      captured_at: true,
    },
  });

  const latest = new Map<string, { metrics: Record<MetricType, number>; capturedAt: Date }>();

  for (const snapshot of snapshots) {
    const entry = latest.get(snapshot.content_item_id) ?? {
      metrics: { ...EMPTY },
      capturedAt: snapshot.captured_at,
    };

    // Rows arrive newest first, so the first value seen for a metric is the
    // current one and later rows for the same metric are history.
    const metric = snapshot.metric_type as MetricType;
    if (entry.metrics[metric] === 0 && METRIC_TYPES.includes(metric)) {
      entry.metrics[metric] = snapshot.value;
    }

    latest.set(snapshot.content_item_id, entry);
  }

  const totals: Record<MetricType, number> = { ...EMPTY };
  let awaitingFirstPoll = 0;

  const rows: ItemPerformance[] = items.map((item) => {
    const found = latest.get(item.content_item_id);
    if (!found) awaitingFirstPoll += 1;

    const metrics = found?.metrics ?? { ...EMPTY };
    for (const metric of METRIC_TYPES) totals[metric] += metrics[metric];

    return {
      content_item_id: item.content_item_id,
      client_id: item.campaign.client.client_id,
      client_name: item.campaign.client.name,
      campaign_title: item.campaign.title,
      content_form: item.content_form,
      platform: item.platform,
      published_at: item.updated_at,
      metrics,
      captured_at: found?.capturedAt ?? null,
    };
  });

  return { items: rows, totals, awaitingFirstPoll };
}

/** The full series for one item, for a chart. Scoped like everything else. */
export async function seriesFor(
  user: ScopeUser,
  contentItemId: string,
  db: Db = prisma,
) {
  const scope = await clientScopeWhere(user, db);

  // Scope checked on the item, not on the snapshot: an item outside scope simply
  // has no series, which is the same answer as an item with no data. A caller
  // must not learn from the difference that another client's post exists.
  const item = await db.contentItem.findFirst({
    where: { content_item_id: contentItemId, campaign: { is: scope } },
    select: { content_item_id: true },
  });

  if (!item) return [];

  return db.metricSnapshot.findMany({
    where: { content_item_id: contentItemId },
    orderBy: { captured_at: "asc" },
    select: { metric_type: true, value: true, captured_at: true },
  });
}
