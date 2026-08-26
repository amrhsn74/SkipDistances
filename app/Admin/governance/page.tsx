import { prisma } from "@/db";
import { openGovernanceFlags } from "@/domain/misuse";

import { PageHeader } from "../../components/Page";
import { FlagQueue, type FlagRow } from "./FlagQueue";

/**
 * The Admin's queue: conduct, not content.
 *
 * `openGovernanceFlags` excludes content flags deliberately -- a brand violation
 * goes to the account manager handling that brief, and mixing the two would bury
 * conduct in routine work. So this page is the five governance types and nothing
 * else.
 *
 * `?resolved=1` shows the history. Resolved rows are kept rather than deleted,
 * because "this was looked at and closed with these notes" is itself part of the
 * record.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Governance · Skip Studio" };

export default async function Page({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const includeResolved = searchParams.resolved === "1";

  const flags = await openGovernanceFlags({ includeResolved });

  // Clause codes are resolved here rather than in the domain function: the queue
  // is a read for one screen, and `openGovernanceFlags` is also called by the
  // overview, which needs a count and not a join.
  const clauseIds = flags
    .map((flag) => flag.clause_id)
    .filter((id): id is string => Boolean(id));

  const clauses = clauseIds.length
    ? await prisma.guidelineClause.findMany({
        where: { clause_id: { in: clauseIds } },
        select: { clause_id: true, clause_code: true },
      })
    : [];
  const clauseCode = new Map(clauses.map((c) => [c.clause_id, c.clause_code]));

  const rows: FlagRow[] = flags.map((flag) => ({
    flag_id: flag.flag_id,
    flag_type: flag.flag_type,
    severity: flag.severity,
    created_at: flag.created_at.toISOString(),
    resolved: flag.resolved,
    resolution_notes: flag.resolution_notes,
    raised_against: flag.raised_against,
    // Parsed on the server so the client component renders rather than parses,
    // and so a malformed blob degrades to an empty object instead of throwing
    // in the browser.
    detail: parseDetails(flag.details),
    clause_code: flag.clause_id ? (clauseCode.get(flag.clause_id) ?? null) : null,
  }));

  return (
    <>
      <PageHeader
        title="Governance"
        description="Conduct flags, worst first. Content flags go to the account manager handling that brief."
      />

      <div className="mb-4 flex gap-2 text-sm">
        <a
          href="/Admin/governance"
          className={`rounded-xl border px-3 py-1.5 font-semibold ${
            includeResolved ? "border-edge text-body" : "border-amber-brand text-amber-dark"
          }`}
        >
          Open
        </a>
        <a
          href="/Admin/governance?resolved=1"
          className={`rounded-xl border px-3 py-1.5 font-semibold ${
            includeResolved ? "border-amber-brand text-amber-dark" : "border-edge text-body"
          }`}
        >
          Including resolved
        </a>
      </div>

      <FlagQueue flags={rows} />
    </>
  );
}

function parseDetails(details: string | null): FlagRow["detail"] {
  if (!details) return {};
  try {
    return JSON.parse(details) as FlagRow["detail"];
  } catch {
    return {};
  }
}
