import { currentUser } from "@/api/request";
import { incomingRequests, serializeIncomingRequest } from "@/domain/clientCalendar";

import { Card, EmptyState, PageHeader } from "../../components/Page";
import { IncomingRequestCard } from "./IncomingRequestCard";

/**
 * What clients have asked for, across the clients this manager holds.
 *
 * The front door to the pipeline, and deliberately not a shortcut through it: a
 * request becomes real work only when the manager converts it into a brief, and
 * that conversion runs the same guarded engine and the same two approvals as
 * anything else.
 *
 * Open requests first, oldest first within them -- a request sitting unanswered
 * for a week is the one holding a client up, and it should not be buried under
 * this morning's.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Requests · Skip Studio" };

export default async function Page() {
  // Non-null: the layout has already called `requireRole`.
  const user = (await currentUser())!;

  const requests = (await incomingRequests(user)).map(serializeIncomingRequest);

  const open = requests.filter((r) => r.status === "new" || r.status === "under_review");
  const closed = requests
    .filter((r) => r.status !== "new" && r.status !== "under_review")
    // Newest first for history: the open list is a work queue, this is a record.
    .reverse();

  return (
    <>
      <PageHeader
        title="Requests"
        description="What your clients have asked for on their calendars."
      />

      <div className="space-y-6">
        <section>
          <h2 className="mb-3 font-heading text-base font-semibold text-heading">
            Waiting on you
          </h2>
          {open.length === 0 ? (
            <Card>
              <EmptyState>Nothing waiting. Requests appear here as clients raise them.</EmptyState>
            </Card>
          ) : (
            <div className="space-y-4">
              {open.map((request) => (
                <IncomingRequestCard key={request.post_request_id} request={request} />
              ))}
            </div>
          )}
        </section>

        {closed.length > 0 ? (
          <section>
            <h2 className="mb-3 font-heading text-base font-semibold text-heading">
              Already dealt with
            </h2>
            <div className="space-y-4">
              {closed.map((request) => (
                <IncomingRequestCard key={request.post_request_id} request={request} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}
