import { currentUser } from "@/api/request";

import { ClauseList } from "../../components/ClauseList";
import { Card, EmptyState, PageHeader } from "../../components/Page";
import { agencyStandards } from "./loadGuidelines";

/**
 * The agency handbook, as a standing reference.
 *
 * Deliberately *only* the agency standards. A creator's clients each have their
 * own brand guide, but a page listing all of them at once answers a question
 * nobody is asking: brand rules only mean something once you know which client
 * you are writing for, and that is decided on the chat screen. So the brand
 * guide surfaces there, against the chosen client, and this page holds the one
 * set of rules that is the same whoever you are writing for.
 *
 * That split is what makes this worth having in the nav at all. The handbook
 * governs every draft, does not change per task, and is the thing a creator
 * wants to consult mid-sentence -- which is exactly what a persistent nav item
 * is for.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Agency standards · Skip Studio" };

export default async function Page() {
  // Non-null: the layout has already called `requireRole`.
  const user = (await currentUser())!;
  const agency = await agencyStandards(user);

  return (
    <>
      <PageHeader
        title="Agency standards"
        description="The rules every draft is written under, for every client. Each client's own brand guide sits on their chat thread."
      />

      {agency.length === 0 ? (
        <EmptyState>
          You are not assigned to any clients yet, so there are no standards to show.
        </EmptyState>
      ) : (
        <Card title={`${agency.length} clauses`}>
          <p className="mb-4 text-sm text-body">
            These apply to every client, including the ones with no brand guide of their own.
          </p>
          <ClauseList clauses={agency} />
        </Card>
      )}
    </>
  );
}
