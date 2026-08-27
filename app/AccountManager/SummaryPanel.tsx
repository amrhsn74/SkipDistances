import Link from "next/link";

import type { Page } from "@/domain/pagination";
import type { ClientSummary, OperationalSummary } from "@/domain/summary";

import {
  Badge,
  Card,
  DataTable,
  EmptyState,
  SectionHeading,
  StatCard,
  StatRow,
} from "../components/Page";
import { Pagination } from "../components/Pagination";

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
 *
 * `clients` arrives as a page, `totals` does not. The stat row above the table
 * counts every client in scope while the table shows ten of them -- and the
 * table says so, rather than leaving a reader to assume the two agree.
 */
export function SummaryPanel({
  totals,
  clients,
  occasions,
  window: dateWindow,
}: {
  totals: OperationalSummary["totals"];
  /** A page of rows. The totals above are still scope-wide -- see the note. */
  clients: Page<ClientSummary>;
  occasions: OccasionRow[];
  window: OperationalSummary["window"];
}) {
  return (
    <div className="space-y-6">
      <StatRow>
        <StatCard
          label="Awaiting internal review"
          value={totals.awaiting.internal_review}
          href="/AccountManager/queue"
          tone="info"
        />
        <StatCard
          label="Awaiting client review"
          value={totals.awaiting.client_review}
          href="/AccountManager/calendar"
          tone="flag"
        />
        <StatCard label="Flagged" value={totals.awaiting.flagged} tone="flag" />
        <StatCard
          label="Publish failed"
          value={totals.awaiting.publish_failed}
          tone="danger"
        />
      </StatRow>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SectionHeading title="By client" count={clients.total} />
          {clients.rows.length === 0 ? (
            <EmptyState>No clients in scope.</EmptyState>
          ) : (
            <DataTable
              headers={["Client", "Campaigns", "Items", "Internal", "Client", "Flagged"]}
            >
              {clients.rows.map((client) => (
                <tr key={client.client_id} className="skip-tr">
                  <td className="px-4 py-3">
                    <p className="font-semibold text-heading">{client.name}</p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-body/70">
                      {client.markets.map((m) => m.country_code).join(", ")}
                      {client.sensitive_sector ? (
                        <Badge tone="flag">Sensitive</Badge>
                      ) : null}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-body">{client.campaign_count}</td>
                  <td className="px-4 py-3 text-body">{client.total_items}</td>
                  <td className="px-4 py-3 text-body">{client.awaiting.internal_review}</td>
                  <td className="px-4 py-3 text-body">{client.awaiting.client_review}</td>
                  <td className="px-4 py-3">
                    {/*
                      A count only wears the flag colours when there is
                      something to colour -- an orange zero on every row is a
                      colour that has stopped meaning anything.
                    */}
                    {client.awaiting.flagged > 0 ? (
                      <span className="skip-pill bg-flag-bg text-flag">
                        {client.awaiting.flagged}
                      </span>
                    ) : (
                      <span className="text-body/50">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}

          {/*
            Rendered whenever there is more than one page. Below the table
            rather than above it, so the numbers a reader came for are the
            first thing under the heading.
          */}
          {clients.totalPages > 1 ? <Pagination page={clients} /> : null}
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
