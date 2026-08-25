import Link from "next/link";

import { prisma } from "@/db";

import { Card, PageHeader } from "../../../components/Page";
import { CreateClientForm } from "../CreateClientForm";

/**
 * Creating a client, on its own page.
 *
 * Its own route rather than a panel that opens over the roster: a half-filled
 * form is now somewhere a person can be, leave, and come back to, and the
 * browser's back button means what they expect.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "New client · Skip Studio" };

export default async function NewClientPage() {
  const markets = await prisma.market.findMany({
    select: { market_id: true, name: true, country_code: true },
    orderBy: { name: "asc" },
  });

  return (
    <>
      <PageHeader
        title="New client"
        description="Every field except the contact can be edited afterwards."
        action={
          <Link href="/AccountManager/clients" className="skip-btn skip-btn-secondary">
            Cancel
          </Link>
        }
      />

      <Card>
        <CreateClientForm markets={markets} />
      </Card>
    </>
  );
}
