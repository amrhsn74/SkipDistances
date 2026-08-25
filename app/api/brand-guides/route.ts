import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { visibleClients } from "@/domain/accessScope";
import {
  clientOfVersion,
  createBrandGuideVersion,
  listBrandGuideVersions,
  serializeVersion,
  serializeVersionWithClauses,
  submitForClientApproval,
  type ClauseInput,
} from "@/domain/brandGuides";
import { enforce } from "@/domain/permissions";
import { prisma } from "@/db";

/**
 * Editing a client's brand guide, over HTTP.
 *
 * The same shell as the other Phase 4 routes -- resolve who is asking, check the
 * capability, hand the work to the domain layer, map a thrown error to a status.
 *
 * What is worth saying about this endpoint is what it deliberately cannot do:
 * **nothing posted here changes what the engine grounds in.** An account manager
 * holds `brand_guide.upload`, not `brand_guide.approve`. A version created or
 * submitted here is `draft` or `pending_client_approval`, and the client's
 * `active_brand_guide_id` is untouched until a client contact approves it
 * through `POST /api/brand-guides/[id]/approve`. That split is the PRD §6 rule:
 * the guide is editable in-app, and gated behind client approval before a new
 * version takes effect.
 */

// Reads the session cookie and writes. Never cached.
export const dynamic = "force-dynamic";

/**
 * POST /api/brand-guides -- draft a new version of a client's guide.
 *
 * Accepts `{ client_id, clauses[] | markdown, submit_for_approval? }`. Clauses
 * may be supplied as structured rows or as the markdown the seeded guides are
 * authored in; the domain layer parses the latter with the seed's own parser so
 * the clause codes stay the one citation vocabulary.
 *
 * Answers 201: a version now exists. It is not the active guide, and saying so
 * is the response's `status` field, not a different status code.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();

    const body = (await request.json()) as Record<string, unknown>;

    // Read before the check, because the capability is client-scoped. An unknown
    // client is passed through as-is and denied by scope, which is the correct
    // answer -- a caller must not learn from the status code whether a client
    // they cannot see happens to exist.
    const clientId = asString(body.client_id ?? body.clientId);

    await enforce(user, "brand_guide.upload", { clientId });

    const created = await createBrandGuideVersion(
      {
        clientId,
        clauses: asClauses(body.clauses),
        markdown: optionalString(body.markdown),
        submitForApproval: asBoolean(body.submit_for_approval ?? body.submitForApproval),
      },
      user.user_id,
    );

    return NextResponse.json(serializeVersionWithClauses(created), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * PATCH /api/brand-guides -- submit an existing draft for client approval.
 *
 * Accepts `{ brand_guide_version_id }`. Kept on the collection route rather than
 * given a path of its own because it is the author's half of the same edit: the
 * one action that closes their window and puts the version in the client's
 * queue. Approving it is the client's action and lives at
 * `/api/brand-guides/[id]/approve`, which is where the plan puts it.
 */
export async function PATCH(request: Request) {
  try {
    const user = await requireUser();

    const body = (await request.json()) as Record<string, unknown>;

    const versionId = asString(body.brand_guide_version_id ?? body.brandGuideVersionId);

    // Resolved to its client before the check, since the capability is scoped.
    // An unknown id yields a null client and is denied by scope rather than
    // answering 404, so a caller learns nothing about guides they cannot see.
    const clientId = versionId ? await clientOfVersion(versionId) : null;

    await enforce(user, "brand_guide.upload", { clientId: clientId ?? undefined });

    const updated = await submitForClientApproval(versionId, user.user_id);

    return NextResponse.json(serializeVersion(updated));
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * GET /api/brand-guides -- version history, scoped to what this user may see.
 *
 * `?client_id=` narrows to one client. Without it, every version of every client
 * in the caller's scope, which is what an account manager's guide list needs.
 *
 * The scope is `visibleClients`, derived from the session, and a named
 * `client_id` outside it returns nothing rather than erroring -- the query is
 * intersected with the caller's scope rather than trusted, so a client_id in the
 * URL can only ever narrow what the session already permits, never widen it.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();

    const scope = await visibleClients(user);

    const requested = new URL(request.url).searchParams.get("client_id");

    if (requested) {
      const permitted = scope.all === true || scope.clientIds.includes(requested);
      if (!permitted) return NextResponse.json({ brand_guide_versions: [] });

      const rows = await listBrandGuideVersions(requested);
      return NextResponse.json({ brand_guide_versions: rows.map(serializeVersion) });
    }

    const rows = await listVersionsForScope(scope.all ? "all" : scope.clientIds);

    return NextResponse.json({ brand_guide_versions: rows.map(serializeVersion) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Every version across the caller's visible clients, newest first. */
async function listVersionsForScope(clientIds: string[] | "all") {
  return prisma.brandGuideVersion.findMany({
    where: clientIds === "all" ? {} : { client_id: { in: clientIds } },
    orderBy: [{ client_id: "asc" }, { version_number: "desc" }],
  });
}

/**
 * Body coercion, kept deliberately dumb -- as on the other Phase 4 routes.
 *
 * A malformed clause array becomes an array of empty-ish rows rather than
 * throwing, so the caller gets `BrandGuideValidationError`'s field-keyed message
 * instead of a 500. The domain function decides whether a value is acceptable;
 * this only decides what type reached it.
 */
function asClauses(value: unknown): ClauseInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((raw) => {
    const c = (raw ?? {}) as Record<string, unknown>;
    return {
      clause_code: asString(c.clause_code ?? c.clauseCode),
      title: asString(c.title),
      text: asString(c.text),
    };
  });
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === "true";
}
