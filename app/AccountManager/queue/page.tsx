import Link from "next/link";

import { currentUser } from "@/api/request";
import { campaignQueuePaged } from "@/domain/campaignQueue";
import { listClients } from "@/domain/clientRoster";
import { parsePage } from "@/domain/pagination";

import { FilterBar } from "../../components/FilterBar";
import { Card, EmptyState, PageHeader } from "../../components/Page";
import { Pagination } from "../../components/Pagination";
import { QueueTable } from "../briefs/QueueTable";

/**
 * Every brief submitted, filtered and paged.
 *
 * The intake form lives on its own route now. This screen is for reading what
 * came back -- and "needs attention" is a filter rather than something to scroll
 * for, because a flagged brief nobody notices is the failure this queue exists
 * to prevent.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Queue · Skip Studio" };

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const user = (await currentUser())!;

  const read = (key: string) => {
    const value = searchParams[key];
    return typeof value === "string" ? value : null;
  };

  const page = parsePage(read("page"), read("size"));

  const [result, clients] = await Promise.all([
    campaignQueuePaged(
      user,
      {
        clientId: read("client"),
        status: read("status"),
        needsAttention: read("attention") === "1",
        search: read("q"),
      },
      page,
    ),
    listClients(user),
  ]);

  return (
    <>
      <PageHeader
        title="Queue"
        description="Every brief you have submitted, newest first."
        action={
          <Link href="/AccountManager/briefs/new" className="skip-btn skip-btn-primary">
            New brief
          </Link>
        }
      />

      <Card>
        <FilterBar
          searchPlaceholder="Brief title…"
          selects={[
            {
              name: "client",
              label: "Client",
              options: clients.map((c) => ({ value: c.client_id, label: c.name })),
            },
            {
              name: "status",
              label: "Status",
              options: [
                { value: "received", label: "Received" },
                { value: "in_progress", label: "In progress" },
                { value: "info_requested", label: "Info requested" },
                { value: "complete", label: "Complete" },
              ],
            },
          ]}
          toggles={[{ name: "attention", label: "Needs attention" }]}
          flush
        />
      </Card>

      {/* The table draws its own card, so it sits outside this one. */}
      <div className="mt-4">
        {result.rows.length === 0 ? (
          <EmptyState>Nothing matches those filters.</EmptyState>
        ) : (
          <QueueTable
            rows={result.rows.map((row) => ({
              ...row,
              // Serialised for the client boundary -- a Date would cross it as a
              // string anyway, so it is converted where the format is chosen.
              created_at: row.created_at.toISOString(),
            }))}
          />
        )}

        <Pagination page={result} />
      </div>
    </>
  );
}
