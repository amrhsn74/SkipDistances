import { prisma } from "@/db";
import { AUDIT_ACTIONS, auditActors, readAuditLog } from "@/domain/auditLog";
import { parsePage } from "@/domain/pagination";

import { FilterBar } from "../../components/FilterBar";
import { Badge, EmptyState, PageHeader } from "../../components/Page";
import { Pagination } from "../../components/Pagination";

/**
 * Every recorded change, filterable.
 *
 * The one view in the product that is not scoped by client. That is the point of
 * it -- the admin's job is oversight, and an audit trail that showed only part of
 * the system would be an audit trail nobody could rely on. `readAuditLog` takes
 * no scope parameter for exactly that reason, and the layout's `requireRole`
 * plus the capability matrix are what keep this page to the one role that should
 * see it.
 *
 * Filters are the four `P11.3` names: client, entity type, action, actor. The
 * client filter is the interesting one -- `AuditLog` holds no client column,
 * because a row describes a *thing that changed* and some of those belong to no
 * client, so filtering by client resolves to the entity ids that client owns.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Audit trail · Skip Studio" };

/** Entity types that actually appear, so the filter offers nothing empty. */
const ENTITY_TYPES = [
  "Client",
  "Campaign",
  "ContentItem",
  "Approval",
  "Flag",
  "BrandGuideVersion",
  "PlatformConnection",
  "PostRequest",
  "Comment",
  "MediaAsset",
  "ReferenceAttachment",
  "ClientAssignment",
  "Conversation",
  "LoginOtp",
  "User",
];

export default async function Page({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const read = (key: string) => {
    const value = searchParams[key];
    return typeof value === "string" && value !== "" ? value : null;
  };

  const page = parsePage(read("page"), read("size"), 25);

  const [result, clients, actors] = await Promise.all([
    readAuditLog(
      {
        clientId: read("client"),
        entityType: read("entity"),
        action: read("action"),
        actorId: read("actor"),
      },
      page,
    ),
    prisma.client.findMany({
      select: { client_id: true, name: true },
      orderBy: { client_id: "asc" },
    }),
    auditActors(),
  ]);

  return (
    <>
      <PageHeader
        title="Audit trail"
        description="Every recorded change, across every client. Append-only — nothing here is edited or deleted."
      />

      <FilterBar
        searchPlaceholder="Filter is by the selects below"
        selects={[
          {
            name: "client",
            label: "Client",
            options: clients.map((client) => ({
              value: client.client_id,
              label: `${client.client_id} · ${client.name}`,
            })),
          },
          {
            name: "entity",
            label: "Entity",
            options: ENTITY_TYPES.map((type) => ({ value: type, label: type })),
          },
          {
            name: "action",
            label: "Action",
            options: AUDIT_ACTIONS.map((action) => ({ value: action, label: action })),
          },
          {
            name: "actor",
            label: "Actor",
            options: actors.map((actor) => ({ value: actor.user_id, label: actor.name })),
          },
        ]}
      />

      {result.rows.length === 0 ? (
        <EmptyState>Nothing recorded matches that.</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-edge bg-surface shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-sm">
              <thead>
                <tr className="border-b border-edge bg-canvas">
                  <th scope="col" className="skip-th">When</th>
                  <th scope="col" className="skip-th">Who</th>
                  <th scope="col" className="skip-th">Action</th>
                  <th scope="col" className="skip-th">Entity</th>
                  <th scope="col" className="skip-th">Detail</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.audit_id} className="skip-tr">
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-body">
                      {row.performed_at.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-xs text-heading">
                      {/* A null actor is the system, not a missing name: the
                          scheduler publishes without a person behind it. */}
                      {row.performed_by?.name ?? "System"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={row.action === "flag_raised" ? "flag" : "neutral"}>
                        {row.action}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-body">
                      {row.entity_type}
                      <span className="block font-mono text-[10px] opacity-70">
                        {row.entity_id}
                      </span>
                    </td>
                    <td className="max-w-md px-4 py-3 text-xs text-body">
                      <span className="line-clamp-2 break-all">{row.details ?? "—"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-4">
        <Pagination page={result} />
      </div>
    </>
  );
}
