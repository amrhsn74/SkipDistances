import Link from "next/link";

import { currentUser } from "@/api/request";
import { prisma } from "@/db";
import { listClientsPaged } from "@/domain/clientRoster";
import { parsePage } from "@/domain/pagination";

import { FilterBar } from "../../components/FilterBar";
import { Card, EmptyState, PageHeader } from "../../components/Page";
import { Pagination } from "../../components/Pagination";
import { RosterTable } from "./RosterTable";

/**
 * The client roster: filtered, paged, and read-only.
 *
 * Creating a client and managing its contacts each have their own route now.
 * A list that also held two forms meant three things competing for one screen,
 * and meant "I was creating a client" was not a place anyone could link to or
 * come back to.
 *
 * Read through the domain layer rather than through this app's own HTTP API --
 * the render already holds a resolved session, and a `fetch` back into the
 * server would re-resolve it for no gain. The scoping is the same either way.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Clients · Skip Studio" };

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // The layout has already guaranteed a signed-in account manager; this narrows
  // the type rather than checking again.
  const user = (await currentUser())!;

  const read = (key: string) => {
    const value = searchParams[key];
    return typeof value === "string" ? value : null;
  };

  const page = parsePage(read("page"), read("size"));

  const [result, markets] = await Promise.all([
    listClientsPaged(
      user,
      {
        search: read("q"),
        status: read("status"),
        marketId: read("market"),
        // Absent means "either", which is not the same as false.
        sensitiveSector: read("sensitive") === "1" ? true : null,
      },
      page,
    ),
    prisma.market.findMany({
      select: { market_id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Clients"
        description="The clients you manage, and the contacts who approve for them."
        action={
          <Link href="/AccountManager/clients/new" className="skip-btn skip-btn-primary">
            New client
          </Link>
        }
      />

      <Card>
        <FilterBar
          searchPlaceholder="Name or client id…"
          selects={[
            {
              name: "status",
              label: "Status",
              options: [
                { value: "active", label: "Active" },
                { value: "inactive", label: "Inactive" },
              ],
            },
            {
              name: "market",
              label: "Market",
              options: markets.map((m) => ({ value: m.market_id, label: m.name })),
            },
          ]}
          toggles={[{ name: "sensitive", label: "Sensitive sector" }]}
        />

        {result.rows.length === 0 ? (
          <EmptyState>
            No clients match those filters. Clear them, or create a client.
          </EmptyState>
        ) : (
          <RosterTable rows={result.rows} />
        )}

        <Pagination page={result} />
      </Card>
    </>
  );
}
