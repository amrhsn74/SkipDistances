import { currentUser } from "@/api/request";
import { clientCalendar, serializeClientCalendar } from "@/domain/clientCalendar";

import { Card, PageHeader } from "../../components/Page";
import { RequestCalendar } from "./RequestCalendar";
import { RequestList } from "./RequestList";

/**
 * The client's calendar, and everything they have asked for.
 *
 * One screen rather than two, because the calendar is how a request is *made*
 * and the list is how it is *tracked* -- splitting them would mean a client who
 * wanted to change yesterday's request had to find a second page to do it on.
 *
 * The month comes from the query string so a particular month is a link
 * somebody can send, the same convention the account manager's calendar uses.
 * The scope does not: it is derived from the session on every request, so
 * editing the URL changes which month is drawn and never whose calendar it is.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Requests · Skip Studio" };

export default async function Page({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  // Non-null: the layout has already called `requireRole`.
  const user = (await currentUser())!;

  const read = (key: string) => {
    const value = searchParams[key];
    return typeof value === "string" ? value : null;
  };

  const now = new Date();
  const year = toInt(read("y"), now.getUTCFullYear());
  const month = clampMonth(toInt(read("m"), now.getUTCMonth() + 1));

  const calendar = serializeClientCalendar(await clientCalendar(user, year, month));

  // Open requests first: those are the ones still worth acting on, and a client
  // with a year of history should not scroll past it to reach them.
  const open = calendar.requests.filter((r) => r.status === "new" || r.status === "under_review");
  const closed = calendar.requests.filter(
    (r) => r.status !== "new" && r.status !== "under_review",
  );

  return (
    <>
      <PageHeader
        title="Requests"
        description="Your calendar, and anything you have asked your account manager for."
      />

      <div className="space-y-6">
        <Card>
          <RequestCalendar
            year={year}
            month={month}
            posts={calendar.posts}
            requests={calendar.requests}
          />
        </Card>

        <section>
          <h2 className="mb-3 font-heading text-base font-semibold text-heading">Open requests</h2>
          <RequestList requests={open} />
        </section>

        {closed.length > 0 ? (
          <section>
            <h2 className="mb-3 font-heading text-base font-semibold text-heading">
              Everything else
            </h2>
            <RequestList requests={closed} />
          </section>
        ) : null}
      </div>
    </>
  );
}

function toInt(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** A month out of range is a typed URL, not an error worth a page for. */
function clampMonth(month: number): number {
  return Math.min(12, Math.max(1, month));
}
