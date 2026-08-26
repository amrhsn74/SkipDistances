import { prisma, type Db } from "../db";
import { PublishError, type Publisher } from "../instagram/client";
import { writeAudit } from "./auditLog";
import { canSchedule } from "./gate";
import { applyTransition, type ContentStatus } from "./statusMachine";

/**
 * Publishing one item, and the re-check that guards it.
 *
 * This is the piece the whole publishing layer exists for. The architecture
 * commits to it plainly: nothing reaches a channel unless **both approvals are
 * still in place at the moment of publishing** -- not merely that they were when
 * it was scheduled. A client who withdraws at 09:59 must stop a 10:00 post.
 *
 * The mechanism is a claim, not a check-then-act:
 *
 *   `updateMany` moves `scheduled -> publishing` **only if the row is still
 *   `scheduled`**, and reports how many rows it changed. Exactly one caller can
 *   see a count of 1. A `findFirst` followed by an `update` would let two
 *   scheduler ticks -- or a tick and a decline -- both read `scheduled` and both
 *   proceed.
 *
 * The gate is read inside that claim, so a decline landing between the read and
 * the write loses: either it got there first and the status is no longer
 * `scheduled`, or it did not and the claim holds.
 *
 * `publishing` is deliberately terminal for decline (`TERMINAL_FOR_DECLINE`), so
 * once the claim succeeds nobody can pull the item out from under a network call
 * that is already in flight. What they get instead is a take-down, which is a
 * different act with its own audit row.
 */

export class PublishNotAllowedError extends Error {
  readonly code = "PUBLISH_NOT_ALLOWED";
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "PublishNotAllowedError";
    this.reason = reason;
  }
}

export type PublishOutcome =
  | { status: "published"; contentItemId: string; platformPostId: string }
  | { status: "skipped"; contentItemId: string; reason: string }
  | { status: "failed"; contentItemId: string; reason: string; retryable: boolean };

/**
 * Try to publish one scheduled item.
 *
 * Returns rather than throws for the ordinary outcomes. The scheduler runs over
 * a batch, and one item whose client withdrew approval is not an error that
 * should stop the other nine.
 */
export async function publishItem(
  contentItemId: string,
  publisher: Publisher,
  db: Db = prisma,
  now: Date = new Date(),
): Promise<PublishOutcome> {
  const item = await db.contentItem.findUnique({
    where: { content_item_id: contentItemId },
    select: {
      content_item_id: true,
      status: true,
      content_body: true,
      scheduled_date: true,
      campaign: { select: { client_id: true } },
      media: { select: { storage_url: true }, take: 1 },
    },
  });

  if (!item) return skip(contentItemId, "No such content item.");
  if (item.status !== "scheduled") {
    return skip(contentItemId, `Status is ${item.status}, not scheduled.`);
  }
  if (!item.scheduled_date || item.scheduled_date.getTime() > now.getTime()) {
    return skip(contentItemId, "Not due yet.");
  }

  // --- The re-check, at the moment of publishing rather than of scheduling. ---
  const gate = await canSchedule(contentItemId, db);
  if (!gate.allowed) {
    // An approval was withdrawn after this was scheduled. The item is unscheduled
    // rather than published, and lands wherever the status machine says a
    // withdrawal leaves it -- `decline` is the cause, because that is what a
    // withdrawn approval is.
    const transition = applyTransition("scheduled", { cause: "decline" });
    await db.contentItem.update({
      where: { content_item_id: contentItemId },
      data: {
        status: transition.ok ? transition.status : "drafted",
        // Unscheduled: the date it was going out on is no longer true, and
        // leaving it would show a withdrawn item on the calendar.
        scheduled_date: null,
      },
    });

    await writeAudit(
      {
        entityType: "ContentItem",
        entityId: contentItemId,
        action: "edited",
        details: { publish_blocked_by: gate.blockedBy, at: now.toISOString() },
      },
      db,
    );

    return skip(contentItemId, `Blocked by ${gate.blockedBy.join(" and ")}.`);
  }

  // --- The claim. ---
  //
  // Conditional on the status still being `scheduled`, so exactly one caller can
  // win. A second tick, or a decline racing this one, changes zero rows and is
  // told so by the count.
  const claimed = await db.contentItem.updateMany({
    where: { content_item_id: contentItemId, status: "scheduled" },
    data: { status: "publishing" },
  });

  if (claimed.count === 0) {
    return skip(contentItemId, "Another tick claimed it, or its status changed.");
  }

  const connection = await db.platformConnection.findFirst({
    where: { client_id: item.campaign.client_id, status: "connected" },
    select: { access_token: true, platform_account_id: true },
  });

  try {
    if (!connection) {
      throw new PublishError("That client has no connected Instagram account.", false);
    }

    const result = await publisher.publish({
      contentItemId,
      body: item.content_body ?? "",
      mediaUrl: item.media[0]?.storage_url ?? null,
      platformAccountId: connection.platform_account_id ?? "",
      accessToken: connection.access_token,
    });

    const transition = applyTransition("publishing", { cause: "publish_succeeded" });
    await db.contentItem.update({
      where: { content_item_id: contentItemId },
      data: { status: transition.ok ? transition.status : "published" },
    });

    await writeAudit(
      {
        entityType: "ContentItem",
        entityId: contentItemId,
        action: "published",
        details: { platform_post_id: result.platformPostId, at: result.publishedAt.toISOString() },
      },
      db,
    );

    return { status: "published", contentItemId, platformPostId: result.platformPostId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Publishing failed.";
    const retryable = error instanceof PublishError ? error.retryable : true;

    // `publish_failed` rather than back to `scheduled`: a silent return to the
    // queue would retry forever and never tell anyone. The operational summary
    // surfaces this status, which is what makes a failure somebody's afternoon
    // rather than a log line.
    await db.contentItem.update({
      where: { content_item_id: contentItemId },
      data: { status: "publish_failed" },
    });

    await writeAudit(
      {
        entityType: "ContentItem",
        entityId: contentItemId,
        action: "edited",
        details: { publish_failed: reason, retryable },
      },
      db,
    );

    return { status: "failed", contentItemId, reason, retryable };
  }
}

/**
 * Take a live post down.
 *
 * Staff-only, and deliberately not a decline. A decline says "this should not
 * have been approved"; a take-down says "this is live and must stop being live",
 * and the two leave different trails because they answer to different people.
 */
export async function takeDown(
  contentItemId: string,
  actorId: string,
  publisher: Publisher,
  db: Db = prisma,
): Promise<void> {
  const item = await db.contentItem.findUnique({
    where: { content_item_id: contentItemId },
    select: {
      status: true,
      campaign: { select: { client_id: true } },
    },
  });

  if (!item) throw new PublishNotAllowedError("No such content item.");
  if (item.status !== "published") {
    throw new PublishNotAllowedError(`Only a published item can be taken down (this is ${item.status}).`);
  }

  const connection = await db.platformConnection.findFirst({
    where: { client_id: item.campaign.client_id, status: "connected" },
    select: { access_token: true },
  });

  const platformPostId = await lastPublishedId(contentItemId, db);
  if (platformPostId && connection) {
    await publisher.remove(platformPostId, connection.access_token);
  }

  await db.contentItem.update({
    where: { content_item_id: contentItemId },
    data: { status: "declined" },
  });

  await writeAudit(
    {
      entityType: "ContentItem",
      entityId: contentItemId,
      action: "take_down",
      performedById: actorId,
      details: { platform_post_id: platformPostId },
    },
    db,
  );
}

/** The id the publish audit row recorded, for a take-down to act on. */
async function lastPublishedId(contentItemId: string, db: Db): Promise<string | null> {
  const row = await db.auditLog.findFirst({
    where: { entity_id: contentItemId, action: "published" },
    orderBy: { performed_at: "desc" },
    select: { details: true },
  });

  if (!row?.details) return null;
  try {
    return (JSON.parse(row.details) as { platform_post_id?: string }).platform_post_id ?? null;
  } catch {
    return null;
  }
}

/** Items due to go out. */
export async function dueForPublishing(
  now: Date = new Date(),
  db: Db = prisma,
): Promise<string[]> {
  const rows = await db.contentItem.findMany({
    where: { status: "scheduled", scheduled_date: { lte: now } },
    select: { content_item_id: true },
    orderBy: { scheduled_date: "asc" },
  });
  return rows.map((row) => row.content_item_id);
}

function skip(contentItemId: string, reason: string): PublishOutcome {
  return { status: "skipped", contentItemId, reason };
}
