import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { clientOfTarget, commentsFor, createComment } from "@/domain/comments";
import { enforce } from "@/domain/permissions";

/**
 * The discussion thread, over HTTP.
 *
 * The same shell as the other Phase 4 routes -- resolve who is asking, check the
 * capability, hand the work to the domain layer, map a thrown error to a status.
 *
 * The claim this endpoint exists to make good on is a negative one: **posting
 * here changes nothing.** No status moves, no approval is withdrawn, no gate is
 * read. A comment saying "the client is happy, go ahead and publish" leaves the
 * item exactly where it was, and a comment saying "skip internal review" is
 * recorded as an override attempt and then likewise changes nothing. That is
 * Clause 0.3's "noted, never obeyed" -- and it is asserted directly in
 * `tests/api/comments.route.test.ts`, which reads an item's status before and
 * after every kind of comment.
 *
 * The capability checked is `campaign.view`, scoped to the target's client. All
 * five roles hold it, which is correct here: anyone who can see a piece of work
 * can discuss it. What they cannot do is discuss another client's work, and that
 * is the scope half of the same check.
 */

// Reads the session cookie and writes. Never cached.
export const dynamic = "force-dynamic";

/**
 * POST /api/comments -- post a message on a request or an item.
 *
 * Accepts `{ post_request_id | content_item_id, body }`. Exactly one target.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();

    const body = (await request.json()) as Record<string, unknown>;

    const postRequestId = optionalString(body.post_request_id ?? body.postRequestId) ?? null;
    const contentItemId = optionalString(body.content_item_id ?? body.contentItemId) ?? null;

    // A comment names a request or an item, never a client, so the target has to
    // be resolved before the client-scoped capability has anything to check
    // against. An unknown target throws here and answers 404 -- reachable only
    // for a caller who could otherwise have seen it, since a target outside
    // their scope is refused by `enforce` on the line below.
    const clientId = await clientOfTarget({ postRequestId, contentItemId });

    await enforce(user, "campaign.view", { clientId });

    const created = await createComment(
      { postRequestId, contentItemId, body: asString(body.body) },
      user.user_id,
    );

    return NextResponse.json(serialize(created), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * GET /api/comments?post_request_id=… | ?content_item_id=… -- read a thread.
 *
 * Scoped the same way as posting: the target is resolved to its client and
 * `enforce` decides, so a client contact reading another client's item id gets a
 * 403 and a flag rather than a thread.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();

    const params = new URL(request.url).searchParams;
    const postRequestId = params.get("post_request_id");
    const contentItemId = params.get("content_item_id");

    const clientId = await clientOfTarget({ postRequestId, contentItemId });

    await enforce(user, "campaign.view", { clientId });

    const rows = await commentsFor(
      postRequestId ? { postRequestId } : { contentItemId: contentItemId as string },
    );

    return NextResponse.json({ comments: rows.map(serialize) });
  } catch (error) {
    return errorResponse(error);
  }
}

function serialize(row: {
  comment_id: string;
  post_request_id: string | null;
  content_item_id: string | null;
  author_id: string | null;
  body: string;
  created_at: Date;
}) {
  return {
    comment_id: row.comment_id,
    post_request_id: row.post_request_id,
    content_item_id: row.content_item_id,
    author_id: row.author_id,
    body: row.body,
    created_at: row.created_at.toISOString(),
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
