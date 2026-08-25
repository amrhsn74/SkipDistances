import Link from "next/link";
import { notFound } from "next/navigation";

import { currentUser } from "@/api/request";
import { getClient } from "@/domain/clientRoster";

import { Badge, Card, PageHeader } from "../../../components/Page";
import { ContactPanel } from "../ContactPanel";

/**
 * One client: its roster row, and the contact who approves for it.
 *
 * `getClient` applies the caller's scope, so a manager who types another
 * manager's client id gets a 404 rather than the page. That is deliberately the
 * same answer as a client id that does not exist -- distinguishing the two would
 * tell a prober which clients are real.
 */
export const dynamic = "force-dynamic";

export default async function ClientPage({ params }: { params: { id: string } }) {
  const user = (await currentUser())!;

  const client = await getClient(user, params.id);
  if (!client) notFound();

  return (
    <>
      <PageHeader
        title={client.name}
        description={`${client.client_id} · ${client.industry}`}
        action={
          <Link href="/AccountManager/clients" className="skip-btn skip-btn-secondary">
            Back to clients
          </Link>
        }
      />

      <div className="space-y-6">
        <Card title="Details">
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Detail label="Status">
              <Badge tone={client.status === "active" ? "ok" : "neutral"}>{client.status}</Badge>
            </Detail>
            <Detail label="Markets">
              {client.markets.map((m) => m.name).join(", ") || "—"}
            </Detail>
            <Detail label="Tier">{client.tier ?? "Not set"}</Detail>
            <Detail label="Channels">{client.channels.join(", ") || "—"}</Detail>
            <Detail label="Account manager">{client.account_manager_name ?? "Unassigned"}</Detail>
            <Detail label="Compliance">
              {client.sensitive_sector ? (
                <Badge tone="flag">Sensitive sector</Badge>
              ) : (
                <span className="text-body">Standard</span>
              )}
            </Detail>
          </dl>
        </Card>

        <ContactPanel clientId={client.client_id} clientName={client.name} />
      </div>
    </>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-body/70">{label}</dt>
      <dd className="mt-1 text-sm text-heading">{children}</dd>
    </div>
  );
}
