import { currentUser } from "@/api/request";
import { visibleClients } from "@/domain/accessScope";
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
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Overview · Skip Studio" };

export default async function AccountManagerHome() {
  // The layout has already guaranteed a signed-in account manager.
  const user = (await currentUser())!;

  const scope = await visibleClients(user);
  const summary = await operationalSummary(scope.all ? "all" : scope.clientIds);

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
          clients={summary.clients}
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
