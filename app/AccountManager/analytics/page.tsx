import { currentUser } from "@/api/request";
import { performanceFor } from "@/domain/analytics";

import { AnalyticsPanel } from "../../components/AnalyticsPanel";
import { PageHeader } from "../../components/Page";

/**
 * Performance across this manager's own clients.
 *
 * Scope is `performanceFor`'s, which reads `clientScopeWhere` -- the same rule
 * every other read layer uses. No client parameter is accepted, deliberately:
 * an endpoint that took one would be a query string away from another manager's
 * numbers.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics · Skip Studio" };

export default async function Page() {
  // Non-null: the layout has already called `requireRole`.
  const user = (await currentUser())!;
  const performance = await performanceFor(user);

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Published performance for the clients you manage."
      />
      <AnalyticsPanel performance={performance} showClient />
    </>
  );
}
