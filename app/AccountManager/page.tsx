import { currentUser } from "@/api/request";
import { visibleClients } from "@/domain/accessScope";
import { parsePage, toPage, toSkipTake } from "@/domain/pagination";
import { operationalSummary } from "@/domain/summary";

import { Card, EmptyState, PageHeader } from "../components/Page";
import { SummaryPanel } from "./SummaryPanel";

/**
 * What is waiting, across the clients this manager holds.
 *
 * PRD §6 makes this the source of truth for what needs a human: reminders are
 * out of scope, so anything not surfaced here is not surfaced at all. That is
 * why the panel leads with the `awaiting` counts rather than with totals -- a
 * count of 40 published items is history, while one failed publish is somebody's
 * afternoon.
 *
 * Scope comes from `visibleClients`, the same call the API route makes, so the
 * page and the endpoint cannot disagree about which clients this is a summary of.
 *
 * The by-client table is paged, because a content lead or admin sees all 150
 * rows of it and an account manager can hold plenty. The paging is applied to
 * the **rows only** -- every headline number above the table is still computed
 * across the whole scope. A "flagged: 3" that silently meant "3 on this page"
 * would be the panel actively lying about what needs a human, which is the one
 * thing this screen exists to be right about.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Overview · Skip Studio" };

export default async function AccountManagerHome({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // The layout has already guaranteed a signed-in account manager.
  const user = (await currentUser())!;

  const scope = await visibleClients(user);
  const summary = await operationalSummary(scope.all ? "all" : scope.clientIds);

  const read = (key: string) => {
    const value = searchParams[key];
    return typeof value === "string" ? value : null;
  };

  // A smaller default than a full list screen: this table shares the page with
  // the stat row and the occasions panel, and a reader here is scanning for one
  // client rather than working through every row.
  const page = parsePage(read("page"), read("size"), 10);
  const { skip, take } = toSkipTake(page);

  // Sliced in memory rather than in the query, because `operationalSummary`
  // computes the totals from the same set -- paging at the database would make
  // the headline numbers describe one page instead of the whole scope.
  const clientPage = toPage(
    summary.clients.slice(skip, skip + take),
    summary.clients.length,
    page,
  );

  return (
    <>
      <PageHeader
        title={`Good to see you, ${user.name.split(" ")[0]}`}
        description="What is waiting across your clients."
      />

      {summary.totals.clients === 0 ? (
        <Card>
          <EmptyState>
            You manage no clients yet. Create one from the Clients tab to get started.
          </EmptyState>
        </Card>
      ) : (
        <SummaryPanel
          totals={summary.totals}
          clients={clientPage}
          occasions={summary.upcoming_occasions.map((occasion) => ({
            key: occasion.key,
            name: occasion.name,
            category: occasion.category,
            // The earliest date any market in scope observes it on. Markets can
            // differ, which is why this is picked rather than assumed to be one.
            date: occasion.dates
              .map((d) => d.date.toISOString())
              .sort()[0],
          }))}
          window={summary.window}
        />
      )}
    </>
  );
}
