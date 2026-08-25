import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { prisma } from "@/db";
import { enforce } from "@/domain/permissions";
import { instantForZone, scheduleItem, unscheduleItem } from "@/domain/scheduling";

/**
 * Booking and releasing a publish slot.
 *
 * The same shell as every other route: resolve who is asking, check the
 * capability against *this* client, hand the work to the domain layer, map a
 * thrown error to a status. The gate, the past-time refusal and the audit row
 * are all `scheduling`'s; none of them is decided here.
 *
 * The route's own job is the timezone conversion, and it is here rather than in
 * the browser for a specific reason: the zone that matters is the *market's*,
 * which is a database fact. A browser sending its own offset would schedule a
 * Cairo post to the manager's local evening, which on a laptop in another
 * country is the wrong hour with nothing in the record to explain it.
 */

// Reads the session cookie and writes. Never cached.
export const dynamic = "force-dynamic";

/**
 * POST /api/content-items/:id/schedule
 *
 * `{ local_date_time }` — a wall-clock time like "2026-09-01T19:00", read in
 * the item's market timezone. `{ publish_at }` is also accepted for a caller
 * that already holds an exact instant with an offset.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();

    const context = await itemContext(params.id);

    // Client-scoped, so the item has to be resolved to its client before the
    // check means anything. An unknown item passes an undefined client and is
    // denied by scope -- a caller must not learn from the status code whether
    // an item they cannot see exists.
    await enforce(user, "publish.schedule", { clientId: context?.clientId });

    const body = (await request.json()) as Record<string, unknown>;

    const publishAt =
      optionalString(body.publish_at ?? body.publishAt) ??
      instantForZone(
        asString(body.local_date_time ?? body.localDateTime),
        // No market means no local zone to read it in, so UTC is the only
        // honest reading -- and the dialog says so on screen.
        context?.timezone ?? "UTC",
      ).toISOString();

    const result = await scheduleItem(
      { contentItemId: params.id, publishAt },
      user.user_id,
    );

    return NextResponse.json({
      content_item_id: result.contentItemId,
      scheduled_for: result.scheduledFor.toISOString(),
      previous_status: result.previousStatus,
      status: result.status,
      // What the gate said at the moment of booking. Not a licence to publish:
      // the Phase 9 scheduler re-checks atomically at publish time, and that
      // check is the one that counts.
      gate: { allowed: result.gate.allowed, blocked_by: result.gate.blockedBy },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** DELETE /api/content-items/:id/schedule -- give up the slot, keep the approvals. */
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();

    const context = await itemContext(params.id);
    await enforce(user, "publish.schedule", { clientId: context?.clientId });

    const result = await unscheduleItem(params.id, user.user_id);

    return NextResponse.json({
      content_item_id: result.contentItemId,
      status: result.status,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** The client and market timezone for this item, or undefined if there is none. */
async function itemContext(
  contentItemId: string,
): Promise<{ clientId: string; timezone: string | null } | undefined> {
  const item = await prisma.contentItem.findUnique({
    where: { content_item_id: contentItemId },
    select: {
      campaign: { select: { client_id: true } },
      market: { select: { timezone: true } },
    },
  });

  if (!item) return undefined;
  return { clientId: item.campaign.client_id, timezone: item.market?.timezone ?? null };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
