import type { PerformanceSummary } from "@/domain/analytics";

import { Card, EmptyState } from "./Page";

/**
 * Performance, rendered.
 *
 * One component for both the account manager's view and the client's, because
 * `P10.3` says to reuse the same aggregation scoped differently -- and the
 * scoping already happened in `performanceFor` before anything reached here.
 * A component that took a `clientId` and filtered would be a second scoping rule
 * in the layer least able to enforce one.
 *
 * `showClient` is the only difference: a manager's rows span clients, a client's
 * do not.
 */
export function AnalyticsPanel({
  performance,
  showClient,
}: {
  performance: PerformanceSummary;
  showClient: boolean;
}) {
  const { items, totals, awaitingFirstPoll } = performance;

  if (items.length === 0) {
    return (
      <EmptyState>
        Nothing published yet. Numbers appear once a post goes live and the metrics poll runs.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Impressions" value={totals.impressions} />
        <Stat label="Reach" value={totals.reach} />
        <Stat label="Likes" value={totals.likes} />
        <Stat label="Comments" value={totals.comments} />
        <Stat label="Shares" value={totals.shares} />
        <Stat label="Saves" value={totals.saves} />
      </div>

      {awaitingFirstPoll > 0 ? (
        <p className="text-xs text-body">
          {awaitingFirstPoll} published{" "}
          {awaitingFirstPoll === 1 ? "post has" : "posts have"} no numbers yet — the metrics
          poll has not reached {awaitingFirstPoll === 1 ? "it" : "them"}.
        </p>
      ) : null}

      <Card title={`Posts · ${items.length}`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="border-b border-edge text-left text-xs text-body">
              <tr>
                {showClient ? <th className="px-3 py-2 font-semibold">Client</th> : null}
                <th className="px-3 py-2 font-semibold">Post</th>
                <th className="px-3 py-2 text-right font-semibold">Reach</th>
                <th className="px-3 py-2 text-right font-semibold">Likes</th>
                <th className="px-3 py-2 text-right font-semibold">Comments</th>
                <th className="px-3 py-2 text-right font-semibold">Saves</th>
                <th className="px-3 py-2 font-semibold">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {items.map((item) => (
                <tr key={item.content_item_id}>
                  {showClient ? (
                    <td className="px-3 py-2 text-xs text-body">{item.client_name}</td>
                  ) : null}
                  <td className="px-3 py-2">
                    <span className="text-sm text-heading">{item.campaign_title}</span>
                    <span className="block text-xs text-body">
                      {item.content_form}
                      {item.platform ? ` · ${item.platform}` : ""}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right text-sm">{item.metrics.reach}</td>
                  <td className="px-3 py-2 text-right text-sm">{item.metrics.likes}</td>
                  <td className="px-3 py-2 text-right text-sm">{item.metrics.comments}</td>
                  <td className="px-3 py-2 text-right text-sm">{item.metrics.saves}</td>
                  <td className="px-3 py-2 text-xs text-body">
                    {/* Said plainly rather than implied: a number with no poll
                        behind it is not a zero, it is an unknown. */}
                    {item.captured_at ? item.captured_at.toLocaleString() : "not polled yet"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-edge bg-surface p-4">
      <p className="text-xs font-semibold text-heading">{label}</p>
      <p className="mt-1 font-heading text-2xl font-semibold text-heading">
        {value.toLocaleString()}
      </p>
    </div>
  );
}
