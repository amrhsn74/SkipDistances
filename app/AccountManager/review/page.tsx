import { ReviewScreen } from "../../components/review/ReviewScreen";

/**
 * The account manager's internal review queue.
 *
 * The account manager is a client's internal reviewer *by default* (PRD §2) --
 * a content lead only replaces them where one is assigned. So this is the common
 * case, and the content lead's identical screen is the exception, rather than
 * the other way round. Without this route the default reviewer would have no
 * way to approve anything, and every walkthrough would need a content lead
 * assigned first.
 *
 * Scoped to the clients they manage, unlike the lead's cross-client view. That
 * difference is entirely `clientScopeWhere`'s; nothing here knows about it.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Review · Skip Studio" };

export default function Page({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  return (
    <ReviewScreen
      stage="internal"
      title="Review"
      description="Drafts awaiting your internal approval."
      searchParams={searchParams}
    />
  );
}
