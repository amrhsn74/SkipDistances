import { prisma, type Db } from "../db";
import { writeAudit } from "./auditLog";
import { flagOverrideAttempt } from "./misuse";

/**
 * The client-initiated calendar ask.
 *
 * A `PostRequest` is a **front door into the pipeline, not a bypass of it**. It
 * carries no authority, exactly as brief wording and client comments carry none:
 * however detailed or insistent the client's comment, the request cannot become
 * a scheduled item without an account manager deliberately converting it, and
 * the converted campaign then runs the full guarded engine and both approval
 * stages like anything else. Conversion is therefore delegated to
 * `submitBrief` -- the same function `POST /api/campaigns` uses -- rather than
 * reimplemented here, so there is no second path into the engine that could
 * drift from the first.
 *
 * Its own lifecycle is small:
 *
 *   new -- (client edits) --> new
 *   new -- (client withdraws) --> withdrawn
 *   new -- (AM takes it) --> under_review -- (converts) --> converted
 *                                          \-- (declines) --> declined
 *
 * The client may edit or withdraw their own request while it is `new`, and loses
 * that ability the moment an account manager moves it to `under_review` (PRD
 * §6). The lock is an explicit AM action rather than a side effect of reading
 * the row, so both sides can see when the request stopped moving.
 */

export const POST_REQUEST_STATUSES = [
  "new",
  "under_review",
  "converted",
  "declined",
  "withdrawn",
] as const;

export type PostRequestStatus = (typeof POST_REQUEST_STATUSES)[number];

/** The one status at which the requesting client may still change it. */
const CLIENT_EDITABLE: PostRequestStatus = "new";

/** Statuses an account manager may still act on. */
const OPEN_TO_ACCOUNT_MANAGER: readonly PostRequestStatus[] = ["new", "under_review"];

export class PostRequestValidationError extends Error {
  readonly code = "POST_REQUEST_VALIDATION";
  /** Field-keyed so a request form can show each message against its input. */
  readonly issues: Record<string, string>;

  constructor(issues: Record<string, string>) {
    super(`Invalid request: ${Object.keys(issues).join(", ")}.`);
    this.name = "PostRequestValidationError";
    this.issues = issues;
  }
}

/**
 * The request exists, but its current status refuses this action -- editing one
 * an account manager has already taken, or converting one already converted.
 *
 * Separate from the validation error because the body was well-formed: it is the
 * row's state that refuses, and the caller needs the status to say so.
 */
export class PostRequestNotAllowedError extends Error {
  readonly code = "POST_REQUEST_NOT_ALLOWED";
  readonly status: PostRequestStatus;

  constructor(message: string, status: PostRequestStatus) {
    super(message);
    this.name = "PostRequestNotAllowedError";
    this.status = status;
  }
}

export class PostRequestNotFoundError extends Error {
  readonly code = "POST_REQUEST_NOT_FOUND";
  constructor(postRequestId: string) {
    super(`No post request "${postRequestId}".`);
    this.name = "PostRequestNotFoundError";
  }
}

export type CreatePostRequestInput = {
  clientId: string;
  /** The calendar day being asked for. */
  requestedDate: Date;
  /** Set for "change or reschedule this existing post". */
  relatedContentItemId?: string | null;
  /** The client's opening comment, stored as a `Comment` on the request. */
  comment?: string | null;
};

export type PostRequestRow = {
  post_request_id: string;
  client_id: string;
  requested_by_id: string | null;
  requested_date: Date;
  related_content_item_id: string | null;
  status: string;
  linked_campaign_id: string | null;
};

/**
 * Raise a request.
 *
 * The opening comment is stored as a real `Comment` row rather than a column on
 * the request, so the client and account manager share one thread from the first
 * message onward -- the ERD models the conversation that way, and a first
 * message living somewhere different from every later one would have to be
 * merged back together by every reader.
 *
 * Bypass language in that comment is flagged and **not obeyed**, per Clause 0.3.
 * The request is still created normally: an override attempt is recorded, never
 * a reason to refuse the client's actual ask.
 */
export async function createPostRequest(
  input: CreatePostRequestInput,
  requestedById: string,
  db: Db = prisma,
): Promise<PostRequestRow> {
  const issues: Record<string, string> = {};

  const clientId = (input.clientId ?? "").trim();
  if (!clientId) issues.clientId = "A request names the client it is for.";

  const requestedDate = input.requestedDate;
  if (!(requestedDate instanceof Date) || Number.isNaN(requestedDate.getTime())) {
    issues.requestedDate = "A request needs the calendar day being asked for.";
  }

  if (Object.keys(issues).length > 0) throw new PostRequestValidationError(issues);

  // Checked rather than left to the foreign key: an FK failure surfaces as a 500
  // with a Prisma message, and "no such client" is a caller error the form
  // should be able to show against its own field.
  const client = await db.client.findUnique({
    where: { client_id: clientId },
    select: { client_id: true },
  });
  if (!client) {
    throw new PostRequestValidationError({ clientId: `No client ${clientId} on the roster.` });
  }

  if (input.relatedContentItemId) {
    // A reschedule must point at an item belonging to this same client.
    // Otherwise a client contact could name another client's item and learn,
    // from whether the call succeeded, that it exists.
    const item = await db.contentItem.findUnique({
      where: { content_item_id: input.relatedContentItemId },
      select: { campaign: { select: { client_id: true } } },
    });
    if (!item || item.campaign.client_id !== clientId) {
      throw new PostRequestValidationError({
        relatedContentItemId: "That post is not one of this client's.",
      });
    }
  }

  const comment = (input.comment ?? "").trim();

  const created = await db.$transaction(async (tx) => {
    const request = await tx.postRequest.create({
      data: {
        client_id: clientId,
        requested_by_id: requestedById,
        requested_date: requestedDate,
        related_content_item_id: input.relatedContentItemId ?? null,
        status: "new",
      },
    });

    if (comment) {
      await tx.comment.create({
        data: {
          post_request_id: request.post_request_id,
          author_id: requestedById,
          body: comment,
        },
      });
    }

    await writeAudit(
      {
        entityType: "PostRequest",
        entityId: request.post_request_id,
        action: "created",
        performedById: requestedById,
        details: {
          client_id: clientId,
          requested_date: requestedDate.toISOString(),
          related_content_item_id: input.relatedContentItemId ?? null,
          has_comment: Boolean(comment),
        },
      },
      tx,
    );

    return request;
  });

  // Outside the transaction: recording an attempt must never roll back the
  // client's legitimate request, and the flag is about conduct rather than part
  // of the request's own atomic fact.
  if (comment) {
    await flagOverrideAttempt(
      { text: comment, raisedAgainstId: requestedById, source: "comment" },
      db,
    );
  }

  return created;
}

export type UpdatePostRequestInput = {
  requestedDate?: Date;
  relatedContentItemId?: string | null;
};

/**
 * The client changes their own request, while it is still `new`.
 *
 * PRD §6: not a one-shot submission. A client who picked the wrong day should
 * fix it themselves rather than filing a second request and leaving the account
 * manager to guess which one is live.
 *
 * Ownership is the caller's to check -- `permissions.enforce` scopes by client
 * before this is reached. What is enforced *here* is the status: the window
 * closes when an account manager takes the request, whoever is asking.
 */
export async function updatePostRequest(
  postRequestId: string,
  input: UpdatePostRequestInput,
  editedById: string,
  db: Db = prisma,
): Promise<PostRequestRow> {
  const existing = await requireOpenForClient(postRequestId, "edit", db);

  const data: Record<string, unknown> = {};

  if (input.requestedDate !== undefined) {
    if (!(input.requestedDate instanceof Date) || Number.isNaN(input.requestedDate.getTime())) {
      throw new PostRequestValidationError({
        requestedDate: "That is not a date this request can move to.",
      });
    }
    data.requested_date = input.requestedDate;
  }

  if (input.relatedContentItemId !== undefined) {
    if (input.relatedContentItemId === null) {
      data.related_content_item_id = null;
    } else {
      const item = await db.contentItem.findUnique({
        where: { content_item_id: input.relatedContentItemId },
        select: { campaign: { select: { client_id: true } } },
      });
      if (!item || item.campaign.client_id !== existing.client_id) {
        throw new PostRequestValidationError({
          relatedContentItemId: "That post is not one of this client's.",
        });
      }
      data.related_content_item_id = input.relatedContentItemId;
    }
  }

  if (Object.keys(data).length === 0) {
    throw new PostRequestValidationError({ body: "Nothing to change." });
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.postRequest.update({
      where: { post_request_id: postRequestId },
      data,
    });

    await writeAudit(
      {
        entityType: "PostRequest",
        entityId: postRequestId,
        action: "edited",
        performedById: editedById,
        details: {
          from: {
            requested_date: existing.requested_date.toISOString(),
            related_content_item_id: existing.related_content_item_id,
          },
          to: {
            requested_date: updated.requested_date.toISOString(),
            related_content_item_id: updated.related_content_item_id,
          },
        },
      },
      tx,
    );

    return updated;
  });
}

/**
 * The client takes their own request back, while it is still `new`.
 *
 * The row is kept and marked, never deleted: its `Comment` thread is part of the
 * client's conversation with their account manager, and a request that vanishes
 * takes that conversation with it.
 *
 * `withdrawn` is deliberately not `declined`. `declined` is the agency saying
 * no; `withdrawn` is the client changing their mind. An account manager's queue
 * has to be able to tell those apart.
 */
export async function withdrawPostRequest(
  postRequestId: string,
  withdrawnById: string,
  db: Db = prisma,
): Promise<PostRequestRow> {
  await requireOpenForClient(postRequestId, "withdraw", db);

  return db.$transaction(async (tx) => {
    const updated = await tx.postRequest.update({
      where: { post_request_id: postRequestId },
      data: { status: "withdrawn" },
    });

    await writeAudit(
      {
        entityType: "PostRequest",
        entityId: postRequestId,
        action: "edited",
        performedById: withdrawnById,
        details: { from_status: "new", to_status: "withdrawn" },
      },
      tx,
    );

    return updated;
  });
}

/**
 * The account manager takes the request, closing the client's edit window.
 *
 * Explicit rather than implied by a read: a request that locked the instant an
 * account manager glanced at their queue would strip the client's ability to fix
 * a typo with nothing signalling why.
 */
export async function startReview(
  postRequestId: string,
  reviewedById: string,
  db: Db = prisma,
): Promise<PostRequestRow> {
  const existing = await requireRequest(postRequestId, db);
  const status = existing.status as PostRequestStatus;

  if (status !== "new") {
    throw new PostRequestNotAllowedError(
      `Cannot start review on a request that is ${status}.`,
      status,
    );
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.postRequest.update({
      where: { post_request_id: postRequestId },
      data: { status: "under_review" },
    });

    await writeAudit(
      {
        entityType: "PostRequest",
        entityId: postRequestId,
        action: "edited",
        performedById: reviewedById,
        details: { from_status: "new", to_status: "under_review" },
      },
      tx,
    );

    return updated;
  });
}

/** The account manager says no. Distinct from the client withdrawing. */
export async function declinePostRequest(
  postRequestId: string,
  declinedById: string,
  reason: string | null,
  db: Db = prisma,
): Promise<PostRequestRow> {
  const existing = await requireRequest(postRequestId, db);
  const status = existing.status as PostRequestStatus;

  if (!OPEN_TO_ACCOUNT_MANAGER.includes(status)) {
    throw new PostRequestNotAllowedError(
      `Cannot decline a request that is ${status}.`,
      status,
    );
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.postRequest.update({
      where: { post_request_id: postRequestId },
      data: { status: "declined" },
    });

    if (reason && reason.trim()) {
      // Kept in the shared thread rather than a status-only change, so the
      // client sees why in the same place they raised the ask.
      await tx.comment.create({
        data: {
          post_request_id: postRequestId,
          author_id: declinedById,
          body: reason.trim(),
        },
      });
    }

    await writeAudit(
      {
        entityType: "PostRequest",
        entityId: postRequestId,
        action: "edited",
        performedById: declinedById,
        details: { from_status: status, to_status: "declined", has_reason: Boolean(reason) },
      },
      tx,
    );

    return updated;
  });
}

/** Everything the conversion needs to build a brief out of the request. */
export type ConvertPostRequestInput = {
  /** The brief text the account manager writes. The request is the ask, not the brief. */
  rawBriefText: string;
  title?: string | null;
  relatedOccasionId?: string | null;
};

export type ConversionContext = {
  request: PostRequestRow;
  /** The client's own words on the request, oldest first, for the AM's screen. */
  comments: { body: string; author_id: string | null; created_at: Date }[];
};

/**
 * Everything needed to convert, with the status checked.
 *
 * Split out from the conversion itself because the campaign is created by
 * `submitBrief`, which runs Gemini and must not be inside a transaction holding
 * the request row. The caller reads this, submits the brief, then calls
 * `markConverted` -- see `app/api/post-requests/[id]/convert/route.ts`.
 */
export async function prepareConversion(
  postRequestId: string,
  db: Db = prisma,
): Promise<ConversionContext> {
  const request = await requireRequest(postRequestId, db);
  const status = request.status as PostRequestStatus;

  if (!OPEN_TO_ACCOUNT_MANAGER.includes(status)) {
    throw new PostRequestNotAllowedError(
      status === "converted"
        ? "That request has already been converted."
        : `Cannot convert a request that is ${status}.`,
      status,
    );
  }

  const comments = await db.comment.findMany({
    where: { post_request_id: postRequestId },
    orderBy: { created_at: "asc" },
    select: { body: true, author_id: true, created_at: true },
  });

  return { request, comments };
}

/**
 * Record that a request became a campaign.
 *
 * Called *after* `submitBrief` has run the guarded engine. Deliberately not
 * called before: a request marked converted against a campaign that then failed
 * to be created would be a dead link in the trail, and the ERD's
 * `linked_campaign_id` is what makes "which brief did this ask become"
 * answerable at all.
 */
export async function markConverted(
  postRequestId: string,
  campaignId: string,
  convertedById: string,
  db: Db = prisma,
): Promise<PostRequestRow> {
  return db.$transaction(async (tx) => {
    const updated = await tx.postRequest.update({
      where: { post_request_id: postRequestId },
      data: { status: "converted", linked_campaign_id: campaignId },
    });

    await writeAudit(
      {
        entityType: "PostRequest",
        entityId: postRequestId,
        action: "edited",
        performedById: convertedById,
        details: { to_status: "converted", linked_campaign_id: campaignId },
      },
      tx,
    );

    return updated;
  });
}

/** One request, scoped by the caller's visible clients. */
export async function listPostRequests(
  clientIds: string[] | "all",
  db: Db = prisma,
): Promise<PostRequestRow[]> {
  return db.postRequest.findMany({
    where: clientIds === "all" ? {} : { client_id: { in: clientIds } },
    orderBy: { created_at: "desc" },
  });
}

async function requireRequest(postRequestId: string, db: Db): Promise<PostRequestRow> {
  const request = await db.postRequest.findUnique({
    where: { post_request_id: postRequestId },
  });
  if (!request) throw new PostRequestNotFoundError(postRequestId);
  return request;
}

/** Shared guard for the two client-side actions: the row exists and is `new`. */
async function requireOpenForClient(
  postRequestId: string,
  action: "edit" | "withdraw",
  db: Db,
): Promise<PostRequestRow> {
  const request = await requireRequest(postRequestId, db);
  const status = request.status as PostRequestStatus;

  if (status !== CLIENT_EDITABLE) {
    throw new PostRequestNotAllowedError(
      status === "under_review"
        ? `Your account manager is reviewing this request, so it can no longer be ${action}ed.`
        : `Cannot ${action} a request that is ${status}.`,
      status,
    );
  }

  return request;
}
