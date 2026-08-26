import Link from "next/link";

import { currentUser } from "@/api/request";
import { visibleClients } from "@/domain/accessScope";
import { listConversations } from "@/domain/conversations";
import { parsePage, toPage, toSkipTake } from "@/domain/pagination";
import { operationalSummary } from "@/domain/summary";

import { Card, PageHeader } from "../components/Page";
import { SummaryPanel } from "../AccountManager/SummaryPanel";

/**
 * Where everything stands, across every client.
 *
 * The lead is one of the two cross-client roles, so `visibleClients` returns
 * `all` and this is genuinely the whole agency. That makes the account manager's
 * summary panel the right component rather than a near-copy: the question -- what
 * is waiting, and on whom -- is identical, and only the scope differs. A second
 * implementation would be the place the two drift.
 *
 * The by-client table is paged; every headline number above it is still computed
 * across the whole scope. A lead seeing "flagged: 3" that quietly meant "3 on
 * this page" would be the panel lying about what needs a human.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Overview · Skip Studio" };

export default async function ContentLeadHome({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // Non-null: the layout has already called `requireRole`.
  const user = (await currentUser())!;

  const scope = await visibleClients(user);
  const summary = await operationalSummary(scope.all ? "all" : scope.clientIds);

  const read = (key: string) => {
    const value = searchParams[key];
    return typeof value === "string" ? value : null;
  };

  const page = parsePage(read("page"), read("size"), 10);
  const { skip, take } = toSkipTake(page);

  // Sliced in memory, as on the account manager's page: `operationalSummary`
  // computes the totals from the same set, so paging at the database would make
  // the headline numbers describe one page instead of the whole roster.
  const clientPage = toPage(
    summary.clients.slice(skip, skip + take),
    summary.clients.length,
    page,
  );

  const threads = await listConversations(user);

  return (
    <>
      <PageHeader
        title="Overview"
        description="Every client, and what is waiting on a human."
      />

      <div className="mb-6">
        <Card title="Start writing">
          <p className="mb-3 text-sm text-body">
            Produce a plan or a piece of content in conversation, then hand it to a creator to
            finish.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/ContentLead/chat"
              className="inline-block rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white"
            >
              New conversation
            </Link>
            {threads.length > 0 ? (
              <span className="text-xs text-body">
                {threads.length} conversation{threads.length === 1 ? "" : "s"} open
              </span>
            ) : null}
          </div>
        </Card>
      </div>

      <SummaryPanel
        totals={summary.totals}
        clients={clientPage}
        occasions={summary.upcoming_occasions.map((occasion) => ({
          key: occasion.key,
          name: occasion.name,
          category: occasion.category,
          // The earliest date any market in scope observes it on -- markets can
          // differ, so it is picked rather than assumed to be one.
          date: occasion.dates.map((d) => d.date.toISOString()).sort()[0],
        }))}
        window={summary.window}
      />
    </>
  );
}
