import { currentUser } from "@/api/request";
import { performanceFor } from "@/domain/analytics";

import { AnalyticsPanel } from "../../components/AnalyticsPanel";
import { PageHeader } from "../../components/Page";

/**
 * A client's own performance.
 *
 * The identical query to the account manager's view, scoped differently -- which
 * is `P10.3` exactly. `clientScopeWhere` resolves a client contact to the one
 * client they approve for, capped at one by the single-approver invariant, so
 * this cannot widen even if a second assignment row were added by mistake.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Analytics · Skip Studio" };

export default async function Page() {
  // Non-null: the layout has already called `requireRole`.
  const user = (await currentUser())!;
  const performance = await performanceFor(user);

  return (
    <>
      <PageHeader title="Analytics" description="How your published posts are doing." />
      {/* No client column: there is only ever one. */}
      <AnalyticsPanel performance={performance} showClient={false} />
    </>
  );
}
