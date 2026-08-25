import { EmptyState, PageHeader } from "../../components/Page";

export default function Page() {
  return (
    <>
      <PageHeader title="Requests" description="Posts you have asked for." />
      <EmptyState>Arrives in Phase 8.</EmptyState>
    </>
  );
}
