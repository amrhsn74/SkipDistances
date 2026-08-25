import { EmptyState, PageHeader } from "../components/Page";

export default function Page() {
  return (
    <>
      <PageHeader title="Overview" description="Your assigned clients." />
      <EmptyState>Arrives in Phase 7.</EmptyState>
    </>
  );
}
