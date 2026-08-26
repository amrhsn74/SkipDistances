import { prisma } from "@/db";
import { parsePage, toPage, toSkipTake } from "@/domain/pagination";

import { PageHeader } from "../../components/Page";
import { Pagination } from "../../components/Pagination";
import { TeamEditor, type Person, type Team } from "./TeamEditor";

/**
 * Who works on what, across every client.
 *
 * `P11.2` and the PRD both say this is edited on the client record rather than
 * on a person: "the Admin edits the fields directly on a client record; no
 * dedicated user-management screen". So the unit here is a client, and the
 * people are the fields.
 *
 * Paged, because the roster is 150 clients and each row carries four seats.
 * `?q=` filters by name or id, which is what makes the page usable at that size
 * without a second navigation concept.
 *
 * The whole team is loaded in two queries rather than one `clientTeam` call per
 * row: 150 clients would otherwise be 150 round trips for a single page render.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Roles · Skip Studio" };

export default async function Page({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const read = (key: string) => {
    const value = searchParams[key];
    return typeof value === "string" ? value : null;
  };

  const search = (read("q") ?? "").trim();
  const page = parsePage(read("page"), read("size"), 15);
  const { skip, take } = toSkipTake(page);

  const where = search
    ? {
        OR: [
          { name: { contains: search } },
          { client_id: { contains: search } },
        ],
      }
    : {};

  const [clients, total, staff] = await Promise.all([
    prisma.client.findMany({
      where,
      orderBy: { client_id: "asc" },
      skip,
      take,
      select: {
        client_id: true,
        name: true,
        status: true,
        account_manager: { select: { user_id: true, name: true, email: true } },
      },
    }),
    prisma.client.count({ where }),
    prisma.user.findMany({
      where: { status: { not: "disabled" } },
      select: { user_id: true, name: true, email: true, user_type: true },
      orderBy: { name: "asc" },
    }),
  ]);

  // One query for every assignment on this page, rather than one per client.
  const assignments = await prisma.clientAssignment.findMany({
    where: { client_id: { in: clients.map((client) => client.client_id) } },
    select: {
      client_id: true,
      role_on_client: true,
      user: { select: { user_id: true, name: true, email: true } },
    },
  });

  const byClient = new Map<string, typeof assignments>();
  for (const assignment of assignments) {
    const list = byClient.get(assignment.client_id) ?? [];
    list.push(assignment);
    byClient.set(assignment.client_id, list);
  }

  const teams: Team[] = clients.map((client) => {
    const rows = byClient.get(client.client_id) ?? [];
    const of = (role: string): Person[] =>
      rows.filter((row) => row.role_on_client === role).map((row) => row.user);

    return {
      client_id: client.client_id,
      client_name: client.name,
      account_manager: client.account_manager,
      content_leads: of("content_lead"),
      content_creators: of("content_creator"),
      client_approvers: of("client_approver"),
    };
  });

  // Staff for the staff seats; client contacts are never assignable as leads or
  // creators, and `roleAssignment` refuses it server-side regardless.
  const staffOnly = staff
    .filter((person) => person.user_type === "staff")
    .map(({ user_id, name, email }) => ({ user_id, name, email }));
  const contactsAndStaff = staff.map(({ user_id, name, email }) => ({ user_id, name, email }));

  const paged = toPage(teams, total, page);

  return (
    <>
      <PageHeader
        title="Roles"
        description="Who works on each client. Every change is recorded against your name."
      />

      <form method="get" className="mb-4">
        <input
          type="search"
          name="q"
          defaultValue={search}
          placeholder="Filter by client name or id"
          className="w-full max-w-sm rounded-xl border border-edge bg-surface px-3 py-2 text-sm outline-none focus:border-amber-brand"
        />
      </form>

      <div className="space-y-3">
        {paged.rows.map((team) => (
          <div key={team.client_id} className="rounded-2xl border border-edge bg-surface">
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="font-heading text-sm font-semibold text-heading">
                  {team.client_name}
                </p>
                <p className="text-xs text-body">{team.client_id}</p>
              </div>
            </div>
            <TeamEditor
              team={team}
              // The client-contact seat can hold a contact; the others cannot.
              staff={team.client_approvers.length > 0 ? contactsAndStaff : staffOnly}
            />
          </div>
        ))}
      </div>

      <div className="mt-4">
        <Pagination page={paged} />
      </div>
    </>
  );
}
