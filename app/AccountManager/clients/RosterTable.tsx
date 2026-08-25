import Link from "next/link";

import type { RosterEntry } from "@/domain/clientRoster";

import { Badge } from "../../components/Page";

/**
 * The roster rows.
 *
 * A server component: there is nothing interactive left here now that filtering
 * and paging live in the URL, so rendering it on the client would ship the whole
 * page twice for no behaviour.
 */
export function RosterTable({ rows }: { rows: RosterEntry[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-edge text-xs uppercase tracking-wide text-body/70">
            <th className="pb-3 pr-4 font-semibold">Client</th>
            <th className="pb-3 pr-4 font-semibold">Industry</th>
            <th className="pb-3 pr-4 font-semibold">Markets</th>
            <th className="pb-3 pr-4 font-semibold">Status</th>
            <th className="pb-3 font-semibold" />
          </tr>
        </thead>
        <tbody>
          {rows.map((client) => (
            <tr key={client.client_id} className="border-b border-edge/60 last:border-0">
              <td className="py-3 pr-4">
                <span className="font-semibold text-heading">{client.name}</span>
                <span className="ml-2 text-xs text-body/70">{client.client_id}</span>
                {client.sensitive_sector ? (
                  // Derived from the industry, never set by hand. Shown because
                  // it decides whether every campaign this client runs carries
                  // mandatory compliance review.
                  <span className="ml-2">
                    <Badge tone="flag">Sensitive</Badge>
                  </span>
                ) : null}
              </td>
              <td className="py-3 pr-4 text-body">{client.industry}</td>
              <td className="py-3 pr-4 text-body">
                {client.markets.map((m) => m.country_code).join(", ") || "—"}
              </td>
              <td className="py-3 pr-4">
                <Badge tone={client.status === "active" ? "ok" : "neutral"}>
                  {client.status}
                </Badge>
              </td>
              <td className="py-3 text-right">
                <Link
                  href={`/AccountManager/clients/${client.client_id}`}
                  className="text-sm font-semibold text-heading underline underline-offset-4 transition-colors hover:text-flag"
                >
                  Open
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
