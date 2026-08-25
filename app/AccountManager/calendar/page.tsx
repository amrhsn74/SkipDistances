import { currentUser } from "@/api/request";
import { listClients } from "@/domain/clientRoster";
import { monthRange, scheduleBoard } from "@/domain/scheduleBoard";

import { FilterBar } from "../../components/FilterBar";
import { Card, PageHeader } from "../../components/Page";
import { MonthGrid } from "./MonthGrid";

/**
 * The publishing calendar.
 *
 * A real month grid rather than a list, because the question it answers is
 * spatial: what is going out this week, and where are the gaps. A list of
 * timestamps cannot show a Thursday with four posts next to a Friday with none.
 *
 * Items approved but *unscheduled* are drawn in their own tray beside the grid.
 * They have no square to sit in, and leaving them off would make the calendar
 * the one screen that hides work which will otherwise silently never go out.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Calendar · Skip Studio" };

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const user = (await currentUser())!;

  const read = (key: string) => {
    const value = searchParams[key];
    return typeof value === "string" ? value : null;
  };

  const now = new Date();
  const year = Number(read("y")) || now.getUTCFullYear();
  const month = Number(read("m")) || now.getUTCMonth() + 1;

  const range = monthRange(year, month);

  const [items, clients] = await Promise.all([
    scheduleBoard(user, { range, clientId: read("client") }),
    listClients(user),
  ]);

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Approved work, and exactly when it goes out."
      />

      <Card>
        <FilterBar
          searchPlaceholder="Not searchable here"
          selects={[
            {
              name: "client",
              label: "Client",
              options: clients.map((c) => ({ value: c.client_id, label: c.name })),
            },
          ]}
        />

        <MonthGrid
          year={year}
          month={month}
          items={items.map((i) => ({
            ...i,
            // Serialised for the client boundary; the grid renders each item in
            // its own market's zone, which it needs the zone name to do.
            scheduled_date: i.scheduled_date ? i.scheduled_date.toISOString() : null,
          }))}
        />
      </Card>
    </>
  );
}
