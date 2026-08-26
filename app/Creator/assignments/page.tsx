import { currentUser } from "@/api/request";
import { listClients } from "@/domain/clientRoster";
import { creatorQueue, serializeCreatorItem } from "@/domain/creatorQueue";
import { parsePage } from "@/domain/pagination";

import { FilterBar } from "../../components/FilterBar";
import { Card, EmptyState, PageHeader } from "../../components/Page";
import { Pagination } from "../../components/Pagination";
import { CreatorList } from "./CreatorList";

/**
 * A creator's in-progress work, across the clients they are assigned to.
 *
 * The scope is `clientScopeWhere`'s, which for a creator resolves to their
 * `ClientAssignment` rows -- the PRD's "just their assigned clients' in-progress
 * work", with no second scoping rule written here. A creator assigned to nothing
 * gets an empty list rather than an error, which is the honest answer.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Assignments · Skip Studio" };

export default async function Page({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // Non-null: the layout has already called `requireRole`.
  const user = (await currentUser())!;

  const read = (key: string) => {
    const value = searchParams[key];
    return typeof value === "string" ? value : null;
  };

  const page = parsePage(read("page"), read("size"));

  const [result, clients] = await Promise.all([
    creatorQueue(
      user,
      {
        clientId: read("client"),
        status: read("status"),
        flaggedOnly: read("flagged") === "1",
        search: read("q"),
      },
      page,
    ),
    listClients(user),
  ]);

  return (
    <>
      <PageHeader
        title="Assignments"
        description="Drafts on your clients, most recently worked on first."
      />

      <Card>
        <FilterBar
          searchPlaceholder="Campaign title…"
          selects={[
            ...(clients.length > 1
              ? [
                  {
                    name: "client",
                    label: "Client",
                    options: clients.map((c) => ({ value: c.client_id, label: c.name })),
                  },
                ]
              : []),
            {
              name: "status",
              label: "Status",
              options: [
                { value: "drafted", label: "Drafted" },
                { value: "in_refinement", label: "In refinement" },
                { value: "flagged", label: "Flagged" },
                { value: "pending_internal_review", label: "With the reviewer" },
              ],
            },
          ]}
          toggles={[{ name: "flagged", label: "Needs fixing" }]}
        />

        {result.rows.length === 0 ? (
          <EmptyState>
            Nothing in progress on your clients. Drafts appear here once a brief has
            run through the engine.
          </EmptyState>
        ) : (
          <CreatorList items={result.rows.map(serializeCreatorItem)} />
        )}

        <Pagination page={result} />
      </Card>
    </>
  );
}
