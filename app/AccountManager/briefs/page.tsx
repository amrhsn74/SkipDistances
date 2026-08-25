import { currentUser } from "@/api/request";
import { campaignQueue } from "@/domain/campaignQueue";
import { listClients } from "@/domain/clientRoster";

import { Card, EmptyState, PageHeader } from "../../components/Page";
import { BriefIntake } from "./BriefIntake";
import { QueueTable } from "./QueueTable";

/**
 * Brief intake, and the queue of what has been submitted.
 *
 * Both halves on one screen because they are one loop: a manager submits a
 * brief, the engine answers, and the answer appears in the queue below. Putting
 * the outcome on a separate page would hide the one thing they submitted to find
 * out.
 *
 * Read through the domain layer rather than through this app's own HTTP API --
 * the render already holds a resolved session, and a `fetch` back into the
 * server would re-resolve it for no gain. The scoping is the same either way.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Briefs · Skip Studio" };

export default async function BriefsPage() {
  // The layout has already guaranteed a signed-in account manager; this narrows
  // the type rather than checking again.
  const user = (await currentUser())!;

  const [clients, queue] = await Promise.all([
    listClients(user),
    campaignQueue(user),
  ]);

  // Only active clients can take a new brief. An inactive one is on the roster
  // and out of the picker, which is the difference between "not offered" and
  // "offered and then refused after the engine has run".
  const submittable = clients.filter((c) => c.status === "active");

  return (
    <>
      <PageHeader
        title="Briefs"
        description="Submit a brief and see what the engine made of it."
      />

      <div className="space-y-6">
        <Card title="New brief">
          {submittable.length === 0 ? (
            <EmptyState>
              You have no active clients to submit for. Create one first.
            </EmptyState>
          ) : (
            <BriefIntake clients={submittable.map((c) => ({
              client_id: c.client_id,
              name: c.name,
              sensitive_sector: c.sensitive_sector,
            }))} />
          )}
        </Card>

        <Card title="Incoming queue">
          {queue.length === 0 ? (
            <EmptyState>Nothing submitted yet.</EmptyState>
          ) : (
            <QueueTable
              rows={queue.map((row) => ({
                ...row,
                // Serialised for the client boundary -- a Date would cross it as
                // a string anyway, so it is converted where the format is chosen.
                created_at: row.created_at.toISOString(),
              }))}
            />
          )}
        </Card>
      </div>
    </>
  );
}
