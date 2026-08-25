import { currentUser } from "@/api/request";
import { prisma } from "@/db";
import { listClients } from "@/domain/clientRoster";

import { Card, EmptyState, PageHeader } from "../../components/Page";
import { ClientRoster } from "./ClientRoster";

/**
 * The account manager's client list, and the form that adds one.
 *
 * A server component that reads through `listClients`, not through `fetch` of
 * its own API. The route and this page would answer the same question twice,
 * and going through HTTP from the server would cost a round trip to re-resolve a
 * session this render already holds. The scoping is identical either way --
 * `listClients` applies `clientScopeWhere`, so a manager sees their own clients
 * and no others whichever door the question comes through.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Clients · Skip Studio" };

export default async function ClientsPage() {
  // The layout has already guaranteed a signed-in account manager; this is
  // narrowing for the type, not a second check.
  const user = (await currentUser())!;

  const [clients, markets] = await Promise.all([
    listClients(user),
    prisma.market.findMany({
      select: { market_id: true, name: true, country_code: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Clients"
        description="The clients you manage, and the contacts who approve for them."
      />

      {clients.length === 0 ? (
        <Card>
          <EmptyState>
            You manage no clients yet. Create one to get started.
          </EmptyState>
        </Card>
      ) : null}

      <ClientRoster clients={clients} markets={markets} />
    </>
  );
}
