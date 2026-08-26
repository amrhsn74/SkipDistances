/**
 * The Instagram Insights boundary.
 *
 * Mocked for the same reason as publishing: there is no Meta app to poll. The
 * seam is the same shape -- an interface the analytics script depends on -- so a
 * real client is a swap rather than a rewrite.
 *
 * What is *not* mocked is everything the analytics layer is actually judged on:
 * `MetricSnapshot` as a time series rather than a mutable current value, and the
 * per-client scoping that keeps one client's numbers out of another's view.
 *
 * The numbers are deterministic, derived from the item id and the poll time.
 * Random numbers would make a demo chart jump around on every refresh and make
 * any test about growth impossible to write.
 */

/** The six metrics the ERD names. */
export const METRIC_TYPES = [
  "impressions",
  "reach",
  "likes",
  "comments",
  "shares",
  "saves",
] as const;

export type MetricType = (typeof METRIC_TYPES)[number];

export type MetricReading = { metric_type: MetricType; value: number };

export interface InsightsSource {
  /** Cumulative totals for one published post, as Instagram reports them. */
  read(platformPostId: string, publishedAt: Date, now: Date): Promise<MetricReading[]>;
}

/**
 * Plausible numbers that grow over time.
 *
 * Modelled as cumulative-with-decay rather than linear, because that is what
 * engagement actually looks like: most of a post's reach arrives in the first
 * day and the curve flattens. A linear mock would make the analytics view show
 * something no real account ever shows, and would hide the one thing the chart
 * is for -- seeing that a post has stopped growing.
 */
export class MockInsights implements InsightsSource {
  async read(
    platformPostId: string,
    publishedAt: Date,
    now: Date,
  ): Promise<MetricReading[]> {
    const hours = Math.max(0, (now.getTime() - publishedAt.getTime()) / 3_600_000);

    // Saturating curve: ~63% of the ceiling by 24h, ~86% by 48h.
    const maturity = 1 - Math.exp(-hours / 24);
    const seed = hash(platformPostId);

    // A per-post ceiling, stable across polls so the series only ever grows.
    const reachCeiling = 800 + (seed % 4_200);

    const reach = Math.round(reachCeiling * maturity);
    const impressions = Math.round(reach * 1.35);

    // Engagement as a fraction of reach, with per-post variation that stays
    // fixed for that post rather than moving between polls.
    const likeRate = 0.02 + ((seed >> 3) % 40) / 1000;

    return [
      { metric_type: "impressions", value: impressions },
      { metric_type: "reach", value: reach },
      { metric_type: "likes", value: Math.round(reach * likeRate) },
      { metric_type: "comments", value: Math.round(reach * likeRate * 0.08) },
      { metric_type: "shares", value: Math.round(reach * likeRate * 0.12) },
      { metric_type: "saves", value: Math.round(reach * likeRate * 0.2) },
    ];
  }
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** The source the app uses. Always the mock, and the caller says so out loud. */
export function insightsSource(): InsightsSource {
  return new MockInsights();
}
