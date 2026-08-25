import { prisma, type Db } from "../db";
import { resolveOccasions, type ResolvedOccasion } from "./calendar";
import { CONTENT_STATUSES, type ContentStatus } from "./statusMachine";

/**
 * The operational summary -- where every account stands.
 *
 * PRD §6 makes this the source of truth for what is waiting: reminders are out
 * of scope for this version, so if a thing is not visible here, nobody finds out
 * about it. The success criterion is specific about the three axes -- "every
 * client's pipeline by status, market, and upcoming occasion" -- and all three
 * are built here rather than left to the caller to assemble.
 *
 * **Scope is a parameter, not a decision made inside.** `P11.5` reuses this
 * query unscoped for the Admin's cross-client view, and `P5.6` calls it scoped
 * to an account manager's own clients. Deciding scope in here would mean either
 * a second near-identical query for the Admin, or a flag that reaches inside a
 * domain function to widen it -- and a widening flag on a scoped query is
 * exactly the shape of the bug the isolation guarantee cannot afford. So the
 * route resolves `visibleClients(user)` from the session and hands the resulting
 * ids down; this function never asks who is calling.
 *
 * That also keeps it honest under test: passing an explicit id list is how
 * `P11.6` can drive the same query as each role and compare.
 */

/** Which clients to report on. `"all"` is the Admin's and content lead's view. */
export type SummaryScope = string[] | "all";

export type SummaryOptions = {
  /**
   * How far ahead to look for occasions. Defaults to 90 days, which is a
   * planning window rather than a rule -- the caller can widen it.
   */
  occasionWindowDays?: number;
  /** Overridable so a test can pin "now" instead of racing the clock. */
  now?: Date;
};

export type StatusCounts = Record<ContentStatus, number>;

export type ClientSummary = {
  client_id: string;
  name: string;
  status: string;
  sensitive_sector: boolean;
  /** Every market this client operates in. */
  markets: { market_id: string; name: string; country_code: string }[];
  /** Content items by status. Every status is present, including the zeroes. */
  by_status: StatusCounts;
  /** Items whose `market_id` is set, counted per market. */
  by_market: Record<string, number>;
  /** Items with no market -- evergreen or shared-occasion, produced once. */
  market_neutral: number;
  total_items: number;
  campaign_count: number;
  /**
   * What needs a human next. Broken out because these are the numbers the panel
   * exists to surface -- a count of 40 `published` items is history, while one
   * `publish_failed` is someone's afternoon.
   */
  awaiting: {
    internal_review: number;
    client_review: number;
    flagged: number;
    publish_failed: number;
  };
};

export type OperationalSummary = {
  clients: ClientSummary[];
  /** The same counts rolled up across every client in scope. */
  totals: {
    clients: number;
    campaigns: number;
    items: number;
    by_status: StatusCounts;
    awaiting: ClientSummary["awaiting"];
  };
  /**
   * Upcoming occasions across every market any client in scope operates in.
   *
   * Resolved once for the union of markets rather than per client: the seeded
   * roster is 150 clients over two markets, so a per-client resolve would run
   * the same lookup 150 times for two distinct answers.
   */
  upcoming_occasions: ResolvedOccasion[];
  window: { from: string; to: string };
};

const DEFAULT_WINDOW_DAYS = 90;

/**
 * Build the summary for a set of clients.
 *
 * Counts are computed with `groupBy` rather than by loading items and tallying
 * in JS. The roster is 150 clients and the panel is a page load, so the
 * difference is between two queries and every content row in the database
 * crossing the process boundary to be counted.
 */
export async function operationalSummary(
  scope: SummaryScope,
  options: SummaryOptions = {},
  db: Db = prisma,
): Promise<OperationalSummary> {
  const now = options.now ?? new Date();
  const windowDays = options.occasionWindowDays ?? DEFAULT_WINDOW_DAYS;

  const to = new Date(now);
  to.setDate(to.getDate() + windowDays);

  // An empty scope is a real answer, not an error: a brand-new account manager
  // with no clients yet sees an empty panel. Returning early also stops an
  // `in: []` filter from being handed to every query below.
  const clientWhere = scope === "all" ? {} : { client_id: { in: scope } };

  const clients = await db.client.findMany({
    where: clientWhere,
    select: {
      client_id: true,
      name: true,
      status: true,
      sensitive_sector: true,
      markets: { select: { market: { select: { market_id: true, name: true, country_code: true } } } },
    },
    orderBy: { client_id: "asc" },
  });

  if (clients.length === 0) {
    return {
      clients: [],
      totals: {
        clients: 0,
        campaigns: 0,
        items: 0,
        by_status: zeroCounts(),
        awaiting: { internal_review: 0, client_review: 0, flagged: 0, publish_failed: 0 },
      },
      upcoming_occasions: [],
      window: { from: now.toISOString(), to: to.toISOString() },
    };
  }

  const clientIds = clients.map((c) => c.client_id);

  // Campaigns per client, and items grouped two ways. `ContentItem` has no
  // client_id of its own -- it hangs off Campaign -- so the item groupings are
  // keyed by campaign and mapped back through this.
  const campaigns = await db.campaign.findMany({
    where: { client_id: { in: clientIds } },
    select: { campaign_id: true, client_id: true },
  });

  const clientOfCampaign = new Map(campaigns.map((c) => [c.campaign_id, c.client_id]));
  const campaignIds = campaigns.map((c) => c.campaign_id);

  const [byStatus, byMarket] = await Promise.all([
    campaignIds.length > 0
      ? db.contentItem.groupBy({
          by: ["campaign_id", "status"],
          where: { campaign_id: { in: campaignIds } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    campaignIds.length > 0
      ? db.contentItem.groupBy({
          by: ["campaign_id", "market_id"],
          where: { campaign_id: { in: campaignIds } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);

  const summaries = new Map<string, ClientSummary>(
    clients.map((c) => [
      c.client_id,
      {
        client_id: c.client_id,
        name: c.name,
        status: c.status,
        sensitive_sector: c.sensitive_sector,
        markets: c.markets.map((m) => m.market),
        by_status: zeroCounts(),
        by_market: {},
        market_neutral: 0,
        total_items: 0,
        campaign_count: 0,
        awaiting: { internal_review: 0, client_review: 0, flagged: 0, publish_failed: 0 },
      },
    ]),
  );

  for (const campaign of campaigns) {
    const summary = summaries.get(campaign.client_id);
    if (summary) summary.campaign_count += 1;
  }

  for (const row of byStatus) {
    const clientId = clientOfCampaign.get(row.campaign_id);
    const summary = clientId ? summaries.get(clientId) : undefined;
    if (!summary) continue;

    const count = row._count._all;
    // A status outside the known set would be a data bug rather than something
    // to silently fold into a bucket; count it in the total and leave the
    // per-status map alone so the discrepancy is visible rather than hidden.
    if (isContentStatus(row.status)) {
      summary.by_status[row.status] += count;
    }
    summary.total_items += count;

    if (row.status === "pending_internal_review") summary.awaiting.internal_review += count;
    if (row.status === "pending_client_review") summary.awaiting.client_review += count;
    if (row.status === "flagged") summary.awaiting.flagged += count;
    if (row.status === "publish_failed") summary.awaiting.publish_failed += count;
  }

  for (const row of byMarket) {
    const clientId = clientOfCampaign.get(row.campaign_id);
    const summary = clientId ? summaries.get(clientId) : undefined;
    if (!summary) continue;

    const count = row._count._all;
    if (row.market_id === null) {
      summary.market_neutral += count;
    } else {
      summary.by_market[row.market_id] = (summary.by_market[row.market_id] ?? 0) + count;
    }
  }

  const clientSummaries = [...summaries.values()];

  // The union of every market any client in scope operates in. A single-market
  // account manager never sees the other market's occasions, which is the
  // scoping half of the calendar requirement.
  const marketIds = [
    ...new Set(clientSummaries.flatMap((c) => c.markets.map((m) => m.market_id))),
  ];

  const upcoming = await resolveOccasions(marketIds, { from: now, to }, db);

  return {
    clients: clientSummaries,
    totals: rollUp(clientSummaries),
    upcoming_occasions: upcoming,
    window: { from: now.toISOString(), to: to.toISOString() },
  };
}

function rollUp(clients: ClientSummary[]): OperationalSummary["totals"] {
  const by_status = zeroCounts();
  const awaiting = { internal_review: 0, client_review: 0, flagged: 0, publish_failed: 0 };
  let campaigns = 0;
  let items = 0;

  for (const c of clients) {
    campaigns += c.campaign_count;
    items += c.total_items;
    for (const status of CONTENT_STATUSES) by_status[status] += c.by_status[status];
    awaiting.internal_review += c.awaiting.internal_review;
    awaiting.client_review += c.awaiting.client_review;
    awaiting.flagged += c.awaiting.flagged;
    awaiting.publish_failed += c.awaiting.publish_failed;
  }

  return { clients: clients.length, campaigns, items, by_status, awaiting };
}

/**
 * Every status at zero.
 *
 * Present-with-zero rather than absent, so a panel can render a stable set of
 * rows instead of one that reflows as work moves through it -- and so "no items
 * awaiting client review" is distinguishable from "this field was never
 * computed".
 */
function zeroCounts(): StatusCounts {
  return Object.fromEntries(CONTENT_STATUSES.map((s) => [s, 0])) as StatusCounts;
}

function isContentStatus(value: string): value is ContentStatus {
  return (CONTENT_STATUSES as readonly string[]).includes(value);
}
