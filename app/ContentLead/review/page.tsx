import { ReviewScreen } from "../../components/review/ReviewScreen";

/**
 * The content lead's internal review queue.
 *
 * Cross-client by role: a content lead reviews across accounts, which is one of
 * the two deliberate exceptions to client scoping (architecture §10). The scope
 * is still `clientScopeWhere`'s answer, not an absence of scoping -- the breadth
 * comes from the role, not from the screen.
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
      description="Drafts awaiting internal approval, across every client you review."
      searchParams={searchParams}
    />
  );
}
