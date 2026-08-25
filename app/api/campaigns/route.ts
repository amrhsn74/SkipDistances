import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { enforce } from "@/domain/permissions";
import { submitBrief } from "@/engine/submitBrief";

/**
 * Brief intake over HTTP.
 *
 * The same shell as `app/api/clients/route.ts`: resolve who is asking, ask
 * `permissions.enforce` whether they may submit for this client, hand the work
 * to `submitBrief`, map a thrown error to a status. The guarded pipeline is
 * `runIntake`'s, reached through `submitBrief`; nothing about it is decided
 * here.
 *
 * The permission check happens before the body reaches the engine, which matters
 * more here than on the roster route: `runIntake` makes several Gemini calls, so
 * a denial that arrived afterwards would have already spent the tokens -- and
 * would have persisted a campaign row for a client the caller may not touch.
 */

// The response depends on the session cookie, and intake writes. Never cached.
export const dynamic = "force-dynamic";

/**
 * POST /api/campaigns -- submit a brief and run it through the guarded engine.
 *
 * Answers 201 for every outcome the engine reaches, including FLAG and
 * REQUEST_INFO. Those are successful intakes with an unwelcome answer, not
 * failed requests: the campaign row exists, the decision is recorded with its
 * clause, and the account manager revises and re-runs that same campaign. A 4xx
 * would tell a caller the submission did not happen, when it did.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();

    const body = (await request.json()) as Record<string, unknown>;

    // Read before the check, because the capability is client-scoped: `enforce`
    // needs to know which client is being submitted for. An unknown or malformed
    // id is passed through as-is and denied by scope, which is the correct
    // answer -- a caller must not learn from the status code whether a client
    // they cannot see happens to exist.
    const clientId = asString(body.client_id ?? body.clientId);

    await enforce(user, "campaign.submit", { clientId });

    const result = await submitBrief(
      {
        clientId,
        // Accepts the wire's snake_case or the domain layer's camelCase, so a
        // form posting either does not fail on a naming preference.
        rawBriefText: asString(body.raw_brief_text ?? body.rawBriefText),
        title: optionalString(body.title) ?? null,
        relatedOccasionId:
          optionalString(body.related_occasion_id ?? body.relatedOccasionId) ?? null,
      },
      user.user_id,
    );

    // `result.run` carries the whole engine trace -- every retrieved clause, the
    // full generated plan, every compliance judgement. Deliberately not returned
    // here: it is large, and a screen that needs it reads the persisted
    // ContentItem and Flag rows the run already wrote.
    const { run, ...summary } = result;
    void run;

    return NextResponse.json(summary, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Body coercion, kept deliberately dumb -- as on the roster route.
 *
 * A wrong type becomes an empty value rather than throwing, so the caller gets
 * `CampaignValidationError`'s field-keyed message ("A brief needs its text")
 * instead of a 500. `submitBrief` decides whether a value is acceptable; this
 * only decides what type reached it.
 */
function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
