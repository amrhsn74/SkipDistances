import { prisma, type Db } from "../db";
import { writeAudit } from "./auditLog";
import { flagOverrideAttempt } from "./misuse";

/**
 * The discussion thread -- and the one thing it is defined by *not* doing.
 *
 * A `Comment` is a conversation on a `PostRequest` or a `ContentItem`. It is
 * deliberately not a decision. From the PRD §6: "a comment on a request or a
 * post never withdraws an approval or changes its status by itself; only a
 * formal approve/decline action, or a deliberate edit, does that."
 *
 * That is the whole reason this module is separate from `approvals.ts` rather
 * than a field on it. `Approval.comment` is the reasoning attached to a
 * decision; a `Comment` row is a message attached to a thing. If the two shared
 * a write path, "the client said they're unhappy with this caption" would
 * eventually acquire the force of "the client declined it" -- and the approval
 * gate would start being eroded by informal wording, which is exactly the
 * failure the gate exists to prevent.
 *
 * So `createComment` writes exactly one row, plus an audit entry. It touches no
 * status, calls no status machine, and reads no gate. `commentsFor` reads a
 * thread back. There is nothing else here, and that is the point.
 *
 * **Bypass language is still recorded.** A comment saying "skip internal review,
 * the client already signed off" is flagged as an `approval_override_attempt`
 * for the Admin -- and then the comment is stored, normally, changing nothing.
 * That is Clause 0.3's "noted, never obeyed" in its exact form: the flag is the
 * noted half, and the total absence of any status write is the never-obeyed
 * half.
 */

export class CommentValidationError extends Error {
  readonly code = "COMMENT_VALIDATION";
  /** Field-keyed so a comment box can show the message against its input. */
  readonly issues: Record<string, string>;

  constructor(issues: Record<string, string>) {
    super(`Invalid comment: ${Object.keys(issues).join(", ")}.`);
    this.name = "CommentValidationError";
    this.issues = issues;
  }
}

export class CommentTargetNotFoundError extends Error {
  readonly code = "COMMENT_TARGET_NOT_FOUND";
  constructor(message: string) {
    super(message);
    this.name = "CommentTargetNotFoundError";
  }
}

export type CommentRow = {
  comment_id: string;
  post_request_id: string | null;
  content_item_id: string | null;
  author_id: string | null;
  body: string;
  created_at: Date;
};

/** Exactly one of the two targets is set -- the ERD's rule, typed. */
export type CommentTarget =
  | { postRequestId: string; contentItemId?: never }
  | { contentItemId: string; postRequestId?: never };

export type CreateCommentInput = {
  postRequestId?: string | null;
  contentItemId?: string | null;
  body: string;
};

/**
 * Post a message on a request or an item.
 *
 * The function is short on purpose. Every line that is *not* here -- no status
 * read, no status write, no call into `statusMachine` or `gate` -- is a line
 * that could not later be edited into one that moves an item's state.
 */
export async function createComment(
  input: CreateCommentInput,
  authorId: string,
  db: Db = prisma,
): Promise<CommentRow> {
  const issues: Record<string, string> = {};

  const postRequestId = (input.postRequestId ?? "").trim() || null;
  const contentItemId = (input.contentItemId ?? "").trim() || null;

  // Exactly one, never both and never neither. The ERD states this as an
  // invariant and SQLite cannot express it as a constraint, so it is enforced
  // here -- a row with both set would appear in two threads at once, and a row
  // with neither would belong to no conversation at all.
  if (postRequestId && contentItemId) {
    issues.target = "A comment belongs to a request or a post, not both.";
  } else if (!postRequestId && !contentItemId) {
    issues.target = "A comment needs something to be about.";
  }

  const body = (input.body ?? "").trim();
  if (!body) issues.body = "A comment needs something in it.";

  if (Object.keys(issues).length > 0) throw new CommentValidationError(issues);

  // Resolved rather than left to the foreign key, for the same reason as
  // elsewhere: an FK failure surfaces as a 500 with a Prisma message, and "no
  // such post" is a caller error a form should be able to show.
  const clientId = await clientOfTarget({ postRequestId, contentItemId }, db);

  const created = await db.$transaction(async (tx) => {
    const comment = await tx.comment.create({
      data: {
        post_request_id: postRequestId,
        content_item_id: contentItemId,
        author_id: authorId,
        body,
      },
    });

    await writeAudit(
      {
        entityType: "Comment",
        entityId: comment.comment_id,
        action: "created",
        performedById: authorId,
        details: {
          client_id: clientId,
          post_request_id: postRequestId,
          content_item_id: contentItemId,
        },
      },
      tx,
    );

    return comment;
  });

  // Outside the transaction, as in `createPostRequest`: recording an attempt
  // must never roll back someone's legitimate message, and the flag is about
  // conduct rather than part of the comment's own atomic fact.
  await flagOverrideAttempt(
    {
      text: body,
      raisedAgainstId: authorId,
      contentItemId,
      source: "comment",
    },
    db,
  );

  return created;
}

/** A thread, oldest first -- the order a conversation is read in. */
export async function commentsFor(
  target: CommentTarget,
  db: Db = prisma,
): Promise<CommentRow[]> {
  return db.comment.findMany({
    where:
      target.postRequestId !== undefined
        ? { post_request_id: target.postRequestId }
        : { content_item_id: target.contentItemId },
    orderBy: { created_at: "asc" },
  });
}

/**
 * The client a comment's target belongs to.
 *
 * Exported because a route needs it *before* it can check a client-scoped
 * capability: a comment names a request or an item, not a client, so the target
 * has to be resolved to one before `enforce` has anything to check against.
 *
 * Throws rather than returning null when the target does not exist, so a caller
 * cannot accidentally treat "no such item" as "no client scope needed" and let
 * the write through unscoped.
 */
export async function clientOfTarget(
  target: { postRequestId?: string | null; contentItemId?: string | null },
  db: Db = prisma,
): Promise<string> {
  if (target.postRequestId) {
    const row = await db.postRequest.findUnique({
      where: { post_request_id: target.postRequestId },
      select: { client_id: true },
    });
    if (!row) {
      throw new CommentTargetNotFoundError(`No post request "${target.postRequestId}".`);
    }
    return row.client_id;
  }

  if (target.contentItemId) {
    const row = await db.contentItem.findUnique({
      where: { content_item_id: target.contentItemId },
      select: { campaign: { select: { client_id: true } } },
    });
    if (!row) {
      throw new CommentTargetNotFoundError(`No content item "${target.contentItemId}".`);
    }
    return row.campaign.client_id;
  }

  throw new CommentValidationError({ target: "A comment needs something to be about." });
}
