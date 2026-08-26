import { currentUser } from "@/api/request";
import { listClients } from "@/domain/clientRoster";
import { parsePage } from "@/domain/pagination";
import { reviewQueue, serializeReviewItem } from "@/domain/reviewQueue";
import type { ApprovalStage } from "@/domain/statusMachine";

import { FilterBar } from "../FilterBar";
import { Card, EmptyState, PageHeader } from "../Page";
import { Pagination } from "../Pagination";
import { ReviewList } from "./ReviewList";

/**
 * The two-stage review screen, once.
 *
 * Three routes render it -- the account manager's, the content lead's and the
 * client's -- because all three are the same screen. The internal reviewer and
 * the client ask the same question of the same table and act through the same
 * endpoint; only the stage differs, and the stage is fixed by whichever route
 * mounted this, never by anything in the URL.
 *
 * That last part is the whole reason the stage is a prop rather than a search
 * parameter. A `?stage=` would let a client contact render the internal queue
 * and be shown approve buttons that `enforce` then refuses -- a screen that
 * lies about what it can do, which is worse than one that refuses up front.
 *
 * A server component. It resolves the session, the scope and the rows before
 * anything reaches the browser, so the list is authoritative on first paint and
 * a reader cannot see a queue that scope would have narrowed.
 */
export async function ReviewScreen({
  stage,
  title,
  description,
  searchParams,
}: {
  stage: ApprovalStage;
  title: string;
  description: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // Non-null: every route mounting this sits under a layout that has already
  // called `requireRole`, which redirects an unauthenticated visitor.
  const user = (await currentUser())!;

  const read = (key: string) => {
    const value = searchParams[key];
    return typeof value === "string" ? value : null;
  };

  const page = parsePage(read("page"), read("size"));

  const [result, clients] = await Promise.all([
    reviewQueue(
      user,
      stage,
      {
        clientId: read("client"),
        status: read("status"),
        awaitingOnly: read("awaiting") === "1",
        search: read("q"),
      },
      page,
    ),
    listClients(user),
  ]);

  const statusOptions =
    stage === "internal"
      ? [
          { value: "pending_internal_review", label: "Awaiting my review" },
          { value: "internal_approved", label: "Internally approved" },
        ]
      : [
          { value: "pending_client_review", label: "Awaiting my approval" },
          { value: "client_approved", label: "Approved" },
          { value: "scheduled", label: "Scheduled" },
        ];

  return (
    <>
      <PageHeader title={title} description={description} />

      <Card>
        <FilterBar
          searchPlaceholder="Campaign title…"
          selects={[
            // A client contact sees exactly one client, so the filter would be a
            // dropdown with one entry -- offered only where it can narrow
            // something.
            ...(clients.length > 1
              ? [
                  {
                    name: "client",
                    label: "Client",
                    options: clients.map((c) => ({ value: c.client_id, label: c.name })),
                  },
                ]
              : []),
            { name: "status", label: "Status", options: statusOptions },
          ]}
          toggles={[{ name: "awaiting", label: "Waiting on me" }]}
        />

        {result.rows.length === 0 ? (
          <EmptyState>
            Nothing is waiting on you here. Items appear once they reach{" "}
            {stage === "internal" ? "internal review" : "client approval"}.
          </EmptyState>
        ) : (
          <ReviewList stage={stage} items={result.rows.map(serializeReviewItem)} />
        )}

        <Pagination page={result} />
      </Card>
    </>
  );
}
