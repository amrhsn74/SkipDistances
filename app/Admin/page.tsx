import { currentUser } from "@/api/request";
import { openGovernanceFlags } from "@/domain/misuse";
import { parsePage, toPage, toSkipTake } from "@/domain/pagination";
import { operationalSummary } from "@/domain/summary";

import { Card, PageHeader, StatCard } from "../components/Page";
import { SummaryPanel } from "../AccountManager/SummaryPanel";

/**
 * Where every account stands.
 *
 * The PRD gives the admin "a cross-client view of where every account stands",
 * and `P11.5` says to reuse `P4.8`'s summary query unscoped rather than write a
 * second one. So this is the account manager's own panel with `"all"` passed in
 * -- the question is identical and only the scope differs, and a near-copy would
 * be the place the two drift.
 *
 * What is *not* here is as deliberate. There is no approve, no draft, no
 * schedule: the admin is the accountability role, "not involved in day-to-day
 * content work", and `permissions.ts` withholds every content capability from
 * them. A screen offering an action the matrix refuses would be a screen that
 * lies about what the role is.
 *
 * The open-flag count leads, because it is the one number on this page that is
 * the admin's own work rather than someone else's.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Overview · Skip Studio" };

export default async function AdminHome({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // Non-null: the layout has already called `requireRole`.
  const user = (await currentUser())!;
  void user;

  const [summary, flags] = await Promise.all([
    // Unscoped, unlike every other caller of this function.
    operationalSummary("all"),
    openGovernanceFlags(),
  ]);

  const read = (key: string) => {
    const value = searchParams[key];
    return typeof value === "string" ? value : null;
  };

  const page = parsePage(read("page"), read("size"), 10);
  const { skip, take } = toSkipTake(page);

  const clientPage = toPage(
    summary.clients.slice(skip, skip + take),
    summary.clients.length,
    page,
  );

  const high = flags.filter((flag) => flag.severity === "high").length;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Every client, and everything waiting on oversight."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Open misuse flags"
          value={flags.length}
          href="/Admin/governance"
          // Danger only while something high-severity is open. A permanently red
          // tile is a tile an admin stops reading.
          tone={high > 0 ? "danger" : "neutral"}
          hint={high > 0 ? `${high} high severity` : undefined}
        />
        <StatCard
          label="Clients"
          value={summary.totals.clients}
          href="/Admin/roles"
          hint="Who works on what"
        />
        <StatCard
          label="Audit trail"
          value="All"
          href="/Admin/audit"
          hint="Every recorded change"
        />
      </div>

      <div className="mb-6">
        <Card>
          <p className="text-sm text-body">
            This role oversees rather than participates: no drafting, no approvals, no
            scheduling. Every change below was made by somebody else, and the trail says who.
          </p>
        </Card>
      </div>

      <SummaryPanel
        totals={summary.totals}
        clients={clientPage}
        occasions={summary.upcoming_occasions.map((occasion) => ({
          key: occasion.key,
          name: occasion.name,
          category: occasion.category,
          date: occasion.dates.map((d) => d.date.toISOString()).sort()[0],
        }))}
        window={summary.window}
      />
    </>
  );
}
