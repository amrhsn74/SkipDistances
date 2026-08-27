import { EmptyState } from "./Page";
import type { ScopedClause } from "@/domain/retrievalScope";

/**
 * A list of rules, as a creator reads them.
 *
 * Shared between the agency standards in the nav and a client's brand guide on
 * a chat thread, because they are the same thing rendered in two places -- and a
 * second copy would be the place the two drift.
 *
 * The clause code is given equal weight to the text on purpose: it is the
 * vocabulary every citation, flag and refusal in the product speaks in, so a
 * creator who reads "CR.4" on a flagged item should be able to find CR.4 here by
 * eye.
 */
export function ClauseList({ clauses }: { clauses: ScopedClause[] }) {
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
            <span className="skip-clause">{clause.clause_code}</span>
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
