import { currentUser } from "@/api/request";
import { visibleClientIds } from "@/domain/accessScope";
import { guideVersionsForClient, serializeGuideVersion } from "@/domain/brandGuideReview";

import { Card, EmptyState, PageHeader } from "../../components/Page";
import { GuideVersionCard } from "./GuideVersionCard";

/**
 * The client's own brand guide, and the decision on a new version of it.
 *
 * The second thing a client approves, alongside content -- and the one with the
 * wider blast radius: approving a version changes what the engine grounds every
 * future draft in, not just one post. `brand_guide.approve` belongs to the
 * client contact alone in the capability table, so this screen is the only place
 * that decision is taken.
 *
 * The client id comes from `visibleClientIds`, which for a contact resolves to
 * exactly one through their single `ClientAssignment`. It is never read from the
 * URL: a contact who typed another client's id would be reading rules they have
 * no relationship to, and the invariant that caps them at one assignment is what
 * makes "their client" a well-defined thing to resolve at all.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Brand guide · Skip Studio" };

export default async function Page() {
  // Non-null: the layout has already called `requireRole`.
  const user = (await currentUser())!;

  const [clientId] = await visibleClientIds(user);

  const versions = clientId
    ? (await guideVersionsForClient(user, clientId)).map(serializeGuideVersion)
    : [];

  const pending = versions.filter((v) => v.awaiting_client);
  const history = versions.filter((v) => !v.awaiting_client);

  return (
    <>
      <PageHeader
        title="Brand guide"
        description="The rules your content is written against, and any change waiting on you."
      />

      {versions.length === 0 ? (
        <Card>
          <EmptyState>
            {/*
              Not an error state. Most clients have no guide on file and are
              governed by the agency standards alone -- saying so is more use
              than an empty panel that reads as something failing to load.
            */}
            No brand guide on file yet. Your content is written against Skip
            Studio&rsquo;s agency standards until your account manager drafts one.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-6">
          {pending.length > 0 ? (
            <section>
              <h2 className="mb-3 font-heading text-base font-semibold text-heading">
                Waiting on you
              </h2>
              <div className="space-y-4">
                {pending.map((version) => (
                  <GuideVersionCard key={version.brand_guide_version_id} version={version} />
                ))}
              </div>
            </section>
          ) : null}

          <section>
            <h2 className="mb-3 font-heading text-base font-semibold text-heading">
              {pending.length > 0 ? "History" : "Versions"}
            </h2>
            {history.length === 0 ? (
              <Card>
                <EmptyState>Nothing else yet.</EmptyState>
              </Card>
            ) : (
              <div className="space-y-4">
                {history.map((version) => (
                  <GuideVersionCard key={version.brand_guide_version_id} version={version} />
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
