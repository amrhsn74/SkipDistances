import Link from "next/link";

import type { ClientSummary, OperationalSummary } from "@/domain/summary";

import { Card, EmptyState } from "../components/Page";

type OccasionRow = { key: string; name: string; category: string; date: string | undefined };

/**
 * The counts panel.
 *
 * A server component -- there is nothing interactive here, and the numbers are
 * already resolved by the time the page renders. Making it a client component
 * would ship the whole summary twice: once as HTML, once as serialised props.
 *
 * The four `awaiting` numbers lead, and the by-status breakdown follows. That
 * ordering is the panel's whole argument: the PRD has no reminders, so a number
 * nobody looks at is work nobody does.
 */
export function SummaryPanel({
  totals,
  clients,
  occasions,
  window: dateWindow,
}: {
  totals: OperationalSummary["totals"];
  clients: ClientSummary[];
  occasions: OccasionRow[];
  window: OperationalSummary["window"];
}) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Awaiting internal review"
          value={totals.awaiting.internal_review}
          href="/AccountManager/queue"
        />
        <Stat label="Awaiting client review" value={totals.awaiting.client_review} />
        <Stat label="Flagged" value={totals.awaiting.flagged} tone="amber" />
        <Stat label="Publish failed" value={totals.awaiting.publish_failed} tone="red" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card title="By client">
            {clients.length === 0 ? (
              <EmptyState>No clients in scope.</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                      <th className="pb-2 pr-4 font-medium">Client</th>
                      <th className="pb-2 pr-4 font-medium">Campaigns</th>
                      <th className="pb-2 pr-4 font-medium">Items</th>
                      <th className="pb-2 pr-4 font-medium">Internal</th>
                      <th className="pb-2 pr-4 font-medium">Client</th>
                      <th className="pb-2 font-medium">Flagged</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clients.map((client) => (
                      <tr
                        key={client.client_id}
                        className="border-b border-slate-100 last:border-0"
                      >
                        <td className="py-2 pr-4">
                          <span className="font-medium text-slate-900">{client.name}</span>
                          {client.sensitive_sector ? (
                            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
                              Sensitive
                            </span>
                          ) : null}
                          <span className="ml-2 text-xs text-slate-500">
                            {client.markets.map((m) => m.country_code).join(", ")}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-slate-600">{client.campaign_count}</td>
                        <td className="py-2 pr-4 text-slate-600">{client.total_items}</td>
                        <td className="py-2 pr-4 text-slate-600">
                          {client.awaiting.internal_review}
                        </td>
                        <td className="py-2 pr-4 text-slate-600">
                          {client.awaiting.client_review}
                        </td>
                        <td className="py-2 text-slate-600">{client.awaiting.flagged}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <Card title="Upcoming occasions">
          {occasions.length === 0 ? (
            <EmptyState>
              Nothing in the next window across your clients&apos; markets.
            </EmptyState>
          ) : (
            <ul className="space-y-2">
              {occasions.slice(0, 12).map((occasion) => (
                <li key={occasion.key} className="text-sm">
                  <span className="font-medium text-slate-900">{occasion.name}</span>
                  <span className="ml-2 text-xs text-slate-500">{occasion.category}</span>
                  {occasion.date ? (
                    <span className="block text-xs text-slate-500">
                      {occasion.date.slice(0, 10)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-400">
            {dateWindow.from.slice(0, 10)} → {dateWindow.to.slice(0, 10)}
          </p>
        </Card>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  href,
  tone = "slate",
}: {
  label: string;
  value: number;
  href?: string;
  tone?: "slate" | "amber" | "red";
}) {
  const accent = {
    slate: "text-slate-900",
    // Coloured only when there is something to colour. A permanent red zero
    // trains the eye to ignore the one number that matters.
    amber: value > 0 ? "text-amber-700" : "text-slate-900",
    red: value > 0 ? "text-red-700" : "text-slate-900",
  }[tone];

  const body = (
    <>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-3xl font-semibold ${accent}`}>{value}</p>
    </>
  );

  return href ? (
    <Link
      href={href}
      className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm transition-colors hover:border-slate-300"
    >
      {body}
    </Link>
  ) : (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">{body}</div>
  );
}
