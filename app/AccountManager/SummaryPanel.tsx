import Link from "next/link";

import type { ClientSummary, OperationalSummary } from "@/domain/summary";

import { Badge, Card, EmptyState } from "../components/Page";

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
        <Stat
          label="Awaiting client review"
          value={totals.awaiting.client_review}
          href="/AccountManager/calendar"
        />
        <Stat label="Flagged" value={totals.awaiting.flagged} tone="flag" />
        <Stat label="Publish failed" value={totals.awaiting.publish_failed} tone="danger" />
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
                    <tr className="border-b border-edge text-xs uppercase tracking-wide text-body/70">
                      <th className="pb-3 pr-4 font-semibold">Client</th>
                      <th className="pb-3 pr-4 font-semibold">Campaigns</th>
                      <th className="pb-3 pr-4 font-semibold">Items</th>
                      <th className="pb-3 pr-4 font-semibold">Internal</th>
                      <th className="pb-3 pr-4 font-semibold">Client</th>
                      <th className="pb-3 font-semibold">Flagged</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clients.map((client) => (
                      <tr
                        key={client.client_id}
                        className="border-b border-edge/60 last:border-0"
                      >
                        <td className="py-2 pr-4">
                          <span className="font-semibold text-heading">{client.name}</span>
                          {client.sensitive_sector ? (
                            <span className="ml-2">
                              <Badge tone="flag">Sensitive</Badge>
                            </span>
                          ) : null}
                          <span className="ml-2 text-xs text-body/70">
                            {client.markets.map((m) => m.country_code).join(", ")}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-body">{client.campaign_count}</td>
                        <td className="py-2 pr-4 text-body">{client.total_items}</td>
                        <td className="py-2 pr-4 text-body">
                          {client.awaiting.internal_review}
                        </td>
                        <td className="py-2 pr-4 text-body">
                          {client.awaiting.client_review}
                        </td>
                        <td className="py-2 text-body">{client.awaiting.flagged}</td>
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
                  <span className="font-semibold text-heading">{occasion.name}</span>
                  <span className="ml-2 text-xs text-body/70">{occasion.category}</span>
                  {occasion.date ? (
                    <span className="block text-xs text-body/70">
                      {occasion.date.slice(0, 10)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-body/50">
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
  tone = "neutral",
}: {
  label: string;
  value: number;
  href?: string;
  tone?: "neutral" | "flag" | "danger";
}) {
  // Coloured only when there is something to colour. A permanent red zero trains
  // the eye to ignore the one number that matters.
  //
  // Neither of these is amber, deliberately: amber is the brand chrome, so a
  // flagged count in amber would read as decoration rather than as work waiting.
  const accent = {
    neutral: "text-heading",
    flag: value > 0 ? "text-flag" : "text-heading",
    danger: value > 0 ? "text-danger" : "text-heading",
  }[tone];

  const body = (
    <>
      <p className="text-xs uppercase tracking-wide text-body/70">{label}</p>
      <p className={`mt-2 font-heading text-4xl font-semibold ${accent}`}>{value}</p>
    </>
  );

  return href ? (
    <Link
      href={href}
      className="rounded-2xl border border-edge bg-surface p-5 shadow-sm transition-colors hover:border-amber-brand"
    >
      {body}
    </Link>
  ) : (
    <div className="rounded-2xl border border-edge bg-surface p-5 shadow-sm">{body}</div>
  );
}
