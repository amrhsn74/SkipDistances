import Link from "next/link";

import type { RosterEntry } from "@/domain/clientRoster";

import { Badge, DataTable } from "../../components/Page";

/**
 * The roster rows.
 *
 * A server component: there is nothing interactive left here now that filtering
 * and paging live in the URL, so rendering it on the client would ship the whole
 * page twice for no behaviour.
 */
export function RosterTable({ rows }: { rows: RosterEntry[] }) {
  return (
    <DataTable headers={["Client", "Industry", "Markets", "Status", ""]}>
      {rows.map((client) => (
        <tr key={client.client_id} className="skip-tr">
          <td className="px-4 py-3">
            <div className="flex items-center gap-2.5">
              {/*
                The initials tile, not an `Avatar`: that component draws a
                person, and a client is a brand. Same size and rhythm so the
                two read as one family down a column.
              */}
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-amber-brand font-heading text-xs font-bold text-ink">
                {client.name.slice(0, 2).toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="font-semibold text-heading">{client.name}</p>
                <p className="text-xs text-body/70">{client.client_id}</p>
              </div>
              {client.sensitive_sector ? (
                // Derived from the industry, never set by hand. Shown because
                // it decides whether every campaign this client runs carries
                // mandatory compliance review.
                <Badge tone="flag">Sensitive</Badge>
              ) : null}
            </div>
          </td>
          <td className="px-4 py-3 text-body">{client.industry}</td>
          <td className="px-4 py-3 text-body">
            {client.markets.map((m) => m.country_code).join(", ") || "—"}
          </td>
          <td className="px-4 py-3">
            <Badge tone={client.status === "active" ? "ok" : "neutral"}>
              {client.status}
            </Badge>
          </td>
          <td className="px-4 py-3 text-right">
            <Link
              href={`/AccountManager/clients/${client.client_id}`}
              className="text-sm font-semibold text-heading underline underline-offset-4 transition-colors hover:text-flag"
            >
              Open
            </Link>
          </td>
        </tr>
      ))}
    </DataTable>
  );
}
