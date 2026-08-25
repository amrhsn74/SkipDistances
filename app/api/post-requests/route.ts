import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { visibleClients } from "@/domain/accessScope";
import { enforce } from "@/domain/permissions";
import { createPostRequest, listPostRequests } from "@/domain/postRequests";

/**
 * The client's calendar ask, over HTTP.
 *
 * The same shell as the other Phase 4 routes -- resolve who is asking, check the
 * capability, hand the work to the domain layer, map a thrown error to a status.
 *
 * The one thing worth saying about this endpoint is what it deliberately cannot
 * do: **nothing posted here schedules anything.** A `PostRequest` is a front
 * door into the pipeline, not a bypass of it. However the comment is worded, the
 * ask reaches an account manager who must deliberately convert it, and the
 * resulting campaign runs the full guarded engine and both approval stages.
 * Bypass language in the comment is recorded as an override attempt by
 * `createPostRequest` and is never obeyed (Clause 0.3).
 */

// Reads the session cookie and writes. Never cached.
export const dynamic = "force-dynamic";

/**
 * POST /api/post-requests -- a client asks for a post on a day.
 *
 * Accepts `{ client_id, requested_date, related_content_item_id?, comment? }`.
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

    await enforce(user, "post_request.create", { clientId });

    const created = await createPostRequest(
      {
        clientId,
        requestedDate: asDate(body.requested_date ?? body.requestedDate),
        relatedContentItemId:
          optionalString(body.related_content_item_id ?? body.relatedContentItemId) ?? null,
        comment: optionalString(body.comment) ?? null,
      },
      user.user_id,
    );

    return NextResponse.json(serialize(created), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * GET /api/post-requests -- the queue, scoped to what this user may see.
 *
 * One endpoint for both readers: a client contact sees their own client's
 * requests, an account manager sees those of the clients they manage. The
 * difference is entirely `visibleClients`, not a branch here -- scope is derived
 * from the session on every request, never from a query parameter.
 *
 * There is deliberately no `enforce` call. Every client-scoped capability needs
 * a `clientId` to check against, and a queue listing has no single client by
 * definition -- asking `campaign.view` with no client would be denied as
 * `missing_client_context` for every scoped role, which is a caller bug rather
 * than a real answer. `visibleClients` is the check here: it returns exactly the
 * clients this session may see, and an empty list for a user with none, so the
 * query cannot widen past the caller's scope whatever their role.
 */
export async function GET() {
  try {
    const user = await requireUser();

    const scope = await visibleClients(user);

    const rows = await listPostRequests(scope.all ? "all" : scope.clientIds);

    return NextResponse.json({ post_requests: rows.map(serialize) });
  } catch (error) {
    return errorResponse(error);
  }
}

function serialize(row: {
  post_request_id: string;
  client_id: string;
  requested_by_id: string | null;
  requested_date: Date;
  related_content_item_id: string | null;
  status: string;
  linked_campaign_id: string | null;
}) {
  return {
    post_request_id: row.post_request_id,
    client_id: row.client_id,
    requested_by_id: row.requested_by_id,
    requested_date: row.requested_date.toISOString(),
    related_content_item_id: row.related_content_item_id,
    status: row.status,
    linked_campaign_id: row.linked_campaign_id,
  };
}

/**
 * Body coercion, kept deliberately dumb -- as on the other Phase 4 routes.
 *
 * An unparseable date becomes an Invalid Date rather than throwing, so the
 * caller gets `PostRequestValidationError`'s field-keyed message instead of a
 * 500. The domain function decides whether a value is acceptable; this only
 * decides what type reached it.
 */
function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") return new Date(value);
  return new Date(Number.NaN);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
