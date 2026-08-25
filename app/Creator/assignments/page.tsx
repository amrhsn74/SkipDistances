import { EmptyState, PageHeader } from "../../components/Page";

export default function Page() {
  return (
    <>
      <PageHeader title="Assignments" description="Items assigned to you." />
      <EmptyState>Arrives in Phase 7.</EmptyState>
    </>
  );
}
