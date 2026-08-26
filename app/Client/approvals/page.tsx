import { ReviewScreen } from "../../components/review/ReviewScreen";

/**
 * The client's approval queue -- the second stage of the same review.
 *
 * The same screen as the internal reviewer's, at `stage = "client"`. Their list
 * runs one status further, through `scheduled`, because an item with a date
 * booked is still theirs to pull back right up until it publishes.
 *
 * Scoped to their own client, and the stage is fixed here rather than read from
 * the URL -- a client contact cannot render the internal queue by editing a
 * parameter.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Approvals · Skip Studio" };

export default function Page({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  return (
    <ReviewScreen
      stage="client"
      title="Approvals"
      description="Content awaiting your decision, and what you have already approved."
      searchParams={searchParams}
    />
  );
}
