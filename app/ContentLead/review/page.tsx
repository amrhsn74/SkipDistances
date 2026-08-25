import { EmptyState, PageHeader } from "../../components/Page";

export default function Page() {
  return (
    <>
      <PageHeader title="Review" description="Drafts awaiting internal approval." />
      <EmptyState>Arrives in Phase 6.</EmptyState>
    </>
  );
}
