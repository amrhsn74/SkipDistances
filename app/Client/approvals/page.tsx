import { EmptyState, PageHeader } from "../../components/Page";

export default function Page() {
  return (
    <>
      <PageHeader title="Approvals" description="Content awaiting your decision." />
      <EmptyState>Arrives in Phase 6.</EmptyState>
    </>
  );
}
