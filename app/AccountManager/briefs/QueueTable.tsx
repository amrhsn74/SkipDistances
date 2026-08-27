"use client";

import { Badge, DataTable } from "../../components/Page";

type QueueRow = {
  campaign_id: string;
  client_id: string;
  client_name: string;
  title: string;
  status: string;
  override_attempt_detected: boolean;
  compliance_review_required: boolean;
  created_at: string;
  item_count: number;
  flag_count: number;
};

/**
 * The incoming queue.
 *
 * A client component only because the timestamps are formatted in the viewer's
 * locale; the rows themselves are server-rendered data. Formatting on the server
 * would print the server's timezone, which is nobody's.
 */
export function QueueTable({ rows }: { rows: QueueRow[] }) {
  return (
    <DataTable headers={["Brief", "Client", "Status", "Items", "Submitted"]}>
      {rows.map((row) => (
        <tr key={row.campaign_id} className="skip-tr">
          <td className="px-4 py-3">
            <span className="font-semibold text-heading">{row.title}</span>
            <span className="mt-1 flex flex-wrap gap-1">
              {row.override_attempt_detected ? (
                // Recorded, never obeyed. Surfaced because an override
                // attempt is exactly what a manager needs to see about a
                // brief before they act on it.
                <Badge tone="danger">Override attempt</Badge>
              ) : null}
              {row.compliance_review_required ? (
                <Badge tone="info">Compliance review</Badge>
              ) : null}
              {row.flag_count > 0 ? (
                <Badge tone="flag">
                  {row.flag_count} flag{row.flag_count === 1 ? "" : "s"}
                </Badge>
              ) : null}
            </span>
          </td>
          <td className="px-4 py-3 text-body">{row.client_name}</td>
          <td className="px-4 py-3">
            <Badge tone={row.status === "complete" ? "ok" : "neutral"}>{row.status}</Badge>
          </td>
          <td className="px-4 py-3 text-body">{row.item_count}</td>
          <td className="px-4 py-3 whitespace-nowrap text-body">
            {new Date(row.created_at).toLocaleString()}
          </td>
        </tr>
      ))}
    </DataTable>
  );
}
