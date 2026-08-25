import Link from "next/link";

import { currentUser } from "@/api/request";
import { listClients } from "@/domain/clientRoster";

import { Card, EmptyState, PageHeader } from "../../../components/Page";
import { BriefIntake } from "../BriefIntake";

/**
 * Submitting a brief, on its own page.
 *
 * The client picker reads the full roster rather than a page of it: paging a
 * picker would silently hide clients past the first page, and a manager cannot
 * submit for a client the form does not list.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "New brief · Skip Studio" };

export default async function NewBriefPage() {
  const user = (await currentUser())!;

  const clients = await listClients(user);

  // Only active clients can take a new brief. An inactive one is on the roster
  // and out of the picker, which is the difference between "not offered" and
  // "offered and then refused after the engine has run".
  const submittable = clients.filter((c) => c.status === "active");

  return (
    <>
      <PageHeader
        title="New brief"
        description="The engine reads the brief text; every outcome keeps the campaign."
        action={
          <Link href="/AccountManager/queue" className="skip-btn skip-btn-secondary">
            Back to queue
          </Link>
        }
      />

      <Card>
        {submittable.length === 0 ? (
          <EmptyState>You have no active clients to submit for. Create one first.</EmptyState>
        ) : (
          <BriefIntake
            clients={submittable.map((c) => ({
              client_id: c.client_id,
              name: c.name,
              sensitive_sector: c.sensitive_sector,
            }))}
          />
        )}
      </Card>
    </>
  );
}
