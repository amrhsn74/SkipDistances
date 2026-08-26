import { currentUser } from "@/api/request";

import { Badge, Card, EmptyState, PageHeader } from "../../components/Page";
import { creatorGuidelines, type ClientGuidelines } from "./loadGuidelines";
import type { ScopedClause } from "@/domain/retrievalScope";

/**
 * The rules, readable before the writing rather than only cited after it.
 *
 * A creator has always been shown which clauses a draft was grounded in. What
 * they could not do was read the guide first -- so "why did it refuse that" and
 * "what does this brand actually allow" were questions answerable only by
 * generating something and reading the citation. This page answers them up
 * front, for every client the creator is assigned to.
 *
 * The agency standards are listed once at the top rather than repeated under
 * every client, because that is what they are: one handbook governing all of
 * them. Each client then shows only what is theirs.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Guidelines · Skip Studio" };

export default async function Page() {
  // Non-null: the layout has already called `requireRole`.
  const user = (await currentUser())!;
  const clients = await creatorGuidelines(user);

  // Identical for every client, so it is read off the first rather than queried
  // again. A creator assigned to nothing sees the empty state instead.
  const agency = clients[0]?.agency ?? [];

  return (
    <>
      <PageHeader
        title="Guidelines"
        description="The rules every draft is written under. Read them before you brief the engine."
      />

      {clients.length === 0 ? (
        <EmptyState>
          You are not assigned to any clients yet, so there are no brand guides to show.
        </EmptyState>
      ) : (
        <div className="space-y-6">
          <Card title={`Agency standards · ${agency.length} clauses`}>
            <p className="mb-4 text-sm text-body">
              These apply to every client, including the ones with no brand guide of their own.
            </p>
            <ClauseList clauses={agency} />
          </Card>

          {clients.map((client) => (
            <ClientCard key={client.client_id} client={client} />
          ))}
        </div>
      )}
    </>
  );
}

function ClientCard({ client }: { client: ClientGuidelines }) {
  return (
    <Card title={`${client.name} · ${client.industry}`}>
      {client.brand.length === 0 ? (
        <p className="text-sm text-body">
          {/* A real and common state, not a degraded one -- most of the roster
              has no guide, and those clients are governed by the agency
              standards above. Saying so is more useful than an empty box. */}
          No brand guide on file. Content for {client.name} is written to the agency standards
          above.
        </p>
      ) : (
        <>
          <p className="mb-4 text-sm text-body">
            {client.brand.length} clause{client.brand.length === 1 ? "" : "s"} specific to{" "}
            {client.name}, on top of the agency standards.
          </p>
          <ClauseList clauses={client.brand} />
        </>
      )}
    </Card>
  );
}

/**
 * One clause, shown with the code it is cited by.
 *
 * The code is given equal weight to the text on purpose: it is the vocabulary
 * every citation, flag and refusal in the product speaks in, so a creator who
 * reads "CR.4" on a flagged item should be able to find CR.4 here by eye.
 */
function ClauseList({ clauses }: { clauses: ScopedClause[] }) {
  if (clauses.length === 0) {
    return <EmptyState>No clauses on file.</EmptyState>;
  }

  return (
    <ul className="space-y-3">
      {clauses.map((clause) => (
        <li
          key={clause.clause_id}
          className="flex items-start gap-3 rounded-xl border border-edge px-4 py-3"
        >
          <span className="shrink-0">
            <Badge tone="neutral">{clause.clause_code}</Badge>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-heading">{clause.title}</span>
            <span className="mt-1 block text-sm text-body">{clause.text}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
