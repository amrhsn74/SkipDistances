import { currentUser } from "@/api/request";
import { campaignQueue } from "@/domain/campaignQueue";

import { Card, EmptyState, PageHeader } from "../../components/Page";
import { QueueTable } from "../briefs/QueueTable";

/**
 * The queue on its own, for a manager who is reading rather than submitting.
 *
 * The same rows as the panel under the intake form, at a longer limit -- the
 * briefs screen shows the recent tail beneath the form it belongs to, this one
 * is the list itself. Sharing `QueueTable` rather than reimplementing it keeps
 * the two from drifting into showing different columns for the same row.
 *
 * The per-item review screens this links towards arrive in Phase 6.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Queue · Skip Studio" };

export default async function QueuePage() {
  const user = (await currentUser())!;

  const queue = await campaignQueue(user, { limit: 200 });

  return (
    <>
      <PageHeader
        title="Queue"
        description="Every brief you have submitted, newest first."
      />

      <Card>
        {queue.length === 0 ? (
          <EmptyState>Nothing submitted yet.</EmptyState>
        ) : (
          <QueueTable
            rows={queue.map((row) => ({
              ...row,
              created_at: row.created_at.toISOString(),
            }))}
          />
        )}
      </Card>
    </>
  );
}
