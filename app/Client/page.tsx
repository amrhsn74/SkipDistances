import { currentUser } from "@/api/request";
import { visibleClientIds } from "@/domain/accessScope";
import { listClients } from "@/domain/clientRoster";
import { operationalSummary } from "@/domain/summary";

import { Avatar } from "../components/Avatar";
import { Badge, Card, EmptyState, PageHeader, StatCard, StatRow } from "../components/Page";

/**
 * The client's own front page.
 *
 * Two things, and the first is the one the PRD names outright: **who their
 * account manager is.** A direct read of `Client.account_manager_id`, with the
 * email alongside, because there is no messaging in this product -- naming
 * someone a client cannot reach would be a label rather than a contact.
 *
 * The second is where their own work stands, reusing `operationalSummary`
 * scoped to their one client. The same query the account manager's panel runs;
 * the difference is entirely the scope, which comes from the session.
 *
 * A client with no assigned manager renders that fact rather than an empty
 * space. `account_manager_id` is nullable by design -- a former client can have
 * no active owner -- and a blank line where a name should be reads as a page
 * that failed to load.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Overview · Skip Studio" };

export default async function Page() {
  // Non-null: the layout has already called `requireRole`.
  const user = (await currentUser())!;

  // A contact's single `ClientAssignment` resolves to exactly one id. Never read
  // from the URL: the invariant capping them at one assignment is what makes
  // "their client" a well-defined thing to resolve at all.
  const [clientId] = await visibleClientIds(user);

  const [roster, summary] = await Promise.all([
    listClients(user),
    clientId ? operationalSummary([clientId]) : null,
  ]);

  const client = roster.find((c) => c.client_id === clientId) ?? roster[0] ?? null;
  const counts = summary?.clients.find((c) => c.client_id === clientId) ?? null;

  if (!client) {
    return (
      <>
        <PageHeader title="Overview" />
        <Card>
          <EmptyState>
            Your account is not linked to a client yet. Your account manager can
            put that right.
          </EmptyState>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title={client.name} description="Your account, at a glance." />

      <div className="space-y-6">
        <Card title="Your account manager">
          {client.account_manager_name ? (
            <div>
              <div className="flex items-center gap-4">
                <Avatar
                  userId={client.account_manager_id}
                  name={client.account_manager_name}
                  role="account_manager"
                  size="lg"
                  className="h-14 w-14"
                />
                <div className="min-w-0">
                  <p className="font-heading text-lg font-semibold text-heading">
                    {client.account_manager_name}
                  </p>
                  {client.account_manager_email ? (
                    <a
                      href={`mailto:${client.account_manager_email}`}
                      className="text-sm text-body underline underline-offset-4 transition-colors hover:text-heading"
                    >
                      {client.account_manager_email}
                    </a>
                  ) : null}
                </div>
              </div>
              <p className="mt-3 text-sm text-body">
                They submit your briefs, review drafts before they reach you, and
                convert anything you request on the calendar into real work.
              </p>
            </div>
          ) : (
            <EmptyState>
              {/*
                Nullable by design -- a former client can have no active owner.
                Said in words, because a blank where a name should be reads as a
                page that failed to load.
              */}
              No account manager is assigned to you right now. Skip Studio&rsquo;s
              admin assigns one.
            </EmptyState>
          )}
        </Card>

        <Card title="Where your content stands">
          {counts === null || counts.total_items === 0 ? (
            <EmptyState>Nothing drafted yet. Work appears here once it exists.</EmptyState>
          ) : (
            <>
              <StatRow flush>
                {/*
                  The only count on this page that is the client's own move,
                  so it is the only one that carries a colour.
                */}
                <StatCard
                  label="Waiting on you"
                  value={counts.awaiting.client_review}
                  tone="flag"
                  href="/Client/approvals"
                />
                <StatCard
                  label="In review internally"
                  value={counts.awaiting.internal_review}
                />
                <StatCard label="Scheduled" value={counts.by_status.scheduled} />
                <StatCard
                  label="Published"
                  value={counts.by_status.published}
                  tone="ok"
                  href="/Client/analytics"
                />
              </StatRow>

            </>
          )}
        </Card>

        <Card title="Your markets">
          <div className="flex flex-wrap gap-2">
            {client.markets.map((market) => (
              <Badge key={market.market_id}>{market.name}</Badge>
            ))}
          </div>
          <p className="mt-3 text-sm text-body">
            Your content is planned around the occasions in{" "}
            {client.markets.length === 1
              ? client.markets[0]?.name
              : client.markets.map((m) => m.name).join(" and ")}
            .
          </p>
        </Card>
      </div>
    </>
  );
}
