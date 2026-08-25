"use client";

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
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
            <th className="pb-2 pr-4 font-medium">Brief</th>
            <th className="pb-2 pr-4 font-medium">Client</th>
            <th className="pb-2 pr-4 font-medium">Status</th>
            <th className="pb-2 pr-4 font-medium">Items</th>
            <th className="pb-2 font-medium">Submitted</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.campaign_id} className="border-b border-slate-100 last:border-0">
              <td className="py-3 pr-4">
                <span className="font-medium text-slate-900">{row.title}</span>
                <span className="mt-0.5 flex flex-wrap gap-1">
                  {row.override_attempt_detected ? (
                    // Recorded, never obeyed. Surfaced because an override
                    // attempt is exactly what a manager needs to see about a
                    // brief before they act on it.
                    <Badge tone="red">Override attempt</Badge>
                  ) : null}
                  {row.compliance_review_required ? (
                    <Badge tone="amber">Compliance review</Badge>
                  ) : null}
                  {row.flag_count > 0 ? (
                    <Badge tone="amber">
                      {row.flag_count} flag{row.flag_count === 1 ? "" : "s"}
                    </Badge>
                  ) : null}
                </span>
              </td>
              <td className="py-3 pr-4 text-slate-600">{row.client_name}</td>
              <td className="py-3 pr-4">
                <Badge tone={row.status === "complete" ? "green" : "slate"}>{row.status}</Badge>
              </td>
              <td className="py-3 pr-4 text-slate-600">{row.item_count}</td>
              <td className="py-3 text-slate-600">
                {new Date(row.created_at).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: "red" | "amber" | "green" | "slate";
  children: React.ReactNode;
}) {
  const classes = {
    red: "bg-red-100 text-red-800",
    amber: "bg-amber-100 text-amber-800",
    green: "bg-emerald-100 text-emerald-800",
    slate: "bg-slate-100 text-slate-700",
  }[tone];

  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${classes}`}>{children}</span>
  );
}
