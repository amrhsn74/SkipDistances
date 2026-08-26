import { prisma, type Db } from "../db";
import { clientScopeWhere, type ScopeUser } from "./accessScope";
import { monthRange } from "./scheduleBoard";

/**
 * What a client sees on their own calendar.
 *
 * Two different things on one grid: posts that are going out, and requests the
 * client has raised. They are separate tables and separate facts -- a post is
 * work the agency has committed to, a request is a question the client asked --
 * and drawing them the same would let a client read their own ask as a booking.
 *
 * Deliberately narrower than the account manager's `scheduleBoard`. That one
 * includes `client_approved` items with no slot, because an approved item nobody
 * has scheduled is the account manager's problem to notice. A client has no
 * scheduling power, so surfacing "approved but unscheduled" to them would be
 * showing someone a problem they cannot act on.
 *
 * Scoped through `clientScopeWhere` like every other read.
 */

/** Statuses that mean a post is actually going out, or has. */
const CALENDAR_STATUSES = ["scheduled", "publishing", "published", "publish_failed"] as const;

export type CalendarPost = {
  content_item_id: string;
  campaign_title: string;
  content_form: string;
  status: string;
  scheduled_date: Date;
  market_timezone: string | null;
};

export type CalendarRequestRow = {
  post_request_id: string;
  requested_date: Date;
  status: string;
  related_content_item_id: string | null;
  linked_campaign_id: string | null;
  /** The thread on this request, oldest first. */
  comments: {
    comment_id: string;
    author_id: string | null;
    author_name: string | null;
    body: string;
    created_at: Date;
  }[];
  /**
   * Whether the client may still edit or withdraw this.
   *
   * True only while `new`. The window closes when an account manager takes the
   * request into `under_review` -- an explicit action on their side, so both
   * parties can see exactly when the request stopped moving (PRD §6).
   */
  client_editable: boolean;
};

export type ClientCalendar = {
  posts: CalendarPost[];
  requests: CalendarRequestRow[];
};

/** Requests are editable by the client only at this status. */
const CLIENT_EDITABLE_STATUS = "new";

export async function clientCalendar(
  user: ScopeUser,
  year: number,
  month: number,
  db: Db = prisma,
): Promise<ClientCalendar> {
  const scope = await clientScopeWhere(user, db);
  const range = monthRange(year, month);

  const [items, requests] = await Promise.all([
    db.contentItem.findMany({
      where: {
        campaign: { is: scope },
        status: { in: [...CALENDAR_STATUSES] },
        scheduled_date: { gte: range.from, lt: range.to },
      },
      orderBy: { scheduled_date: "asc" },
      take: 500,
      select: {
        content_item_id: true,
        content_form: true,
        status: true,
        scheduled_date: true,
        campaign: { select: { title: true } },
        market: { select: { timezone: true } },
      },
    }),
    // Requests are **not** narrowed to the month. A client's open requests are a
    // short list they need to see whole -- one raised for next quarter would
    // otherwise disappear from the only screen that offers to withdraw it.
    db.postRequest.findMany({
      where: { ...scope },
      orderBy: { created_at: "desc" },
      take: 100,
      select: {
        post_request_id: true,
        requested_date: true,
        status: true,
        related_content_item_id: true,
        linked_campaign_id: true,
        comments: {
          orderBy: { created_at: "asc" },
          select: {
            comment_id: true,
            author_id: true,
            body: true,
            created_at: true,
            author: { select: { name: true } },
          },
        },
      },
    }),
  ]);

  return {
    posts: items.map((item) => ({
      content_item_id: item.content_item_id,
      campaign_title: item.campaign.title,
      content_form: item.content_form,
      status: item.status,
      // Non-null by the `gte`/`lt` filter above, which no null can satisfy.
      scheduled_date: item.scheduled_date!,
      market_timezone: item.market?.timezone ?? null,
    })),
    requests: requests.map((request) => ({
      post_request_id: request.post_request_id,
      requested_date: request.requested_date,
      status: request.status,
      related_content_item_id: request.related_content_item_id,
      linked_campaign_id: request.linked_campaign_id,
      comments: request.comments.map((comment) => ({
        comment_id: comment.comment_id,
        author_id: comment.author_id,
        author_name: comment.author?.name ?? null,
        body: comment.body,
        created_at: comment.created_at,
      })),
      client_editable: request.status === CLIENT_EDITABLE_STATUS,
    })),
  };
}

/** A calendar, ready to cross into a client component. */
export function serializeClientCalendar(calendar: ClientCalendar) {
  return {
    posts: calendar.posts.map((post) => ({
      content_item_id: post.content_item_id,
      campaign_title: post.campaign_title,
      content_form: post.content_form,
      status: post.status,
      scheduled_date: post.scheduled_date.toISOString(),
      market_timezone: post.market_timezone,
    })),
    requests: calendar.requests.map((request) => ({
      post_request_id: request.post_request_id,
      requested_date: request.requested_date.toISOString(),
      status: request.status,
      related_content_item_id: request.related_content_item_id,
      linked_campaign_id: request.linked_campaign_id,
      client_editable: request.client_editable,
      comments: request.comments.map((comment) => ({
        comment_id: comment.comment_id,
        author_id: comment.author_id,
        author_name: comment.author_name,
        body: comment.body,
        created_at: comment.created_at.toISOString(),
      })),
    })),
  };
}

export type ClientCalendarSerialized = ReturnType<typeof serializeClientCalendar>;

/**
 * The account manager's side of the same table.
 *
 * Separate from `clientCalendar` because it answers a different question. A
 * client asks "what did I ask for"; an account manager asks "what has come in,
 * across every client I manage, and which of it is still mine to pick up". So
 * this carries the client's name -- meaningless on a screen scoped to one
 * client, essential on one spanning many -- and orders by what is waiting rather
 * than by calendar month.
 *
 * Scoped through `clientScopeWhere` like every other list, so a manager sees
 * exactly the clients they manage.
 */
export type IncomingRequest = CalendarRequestRow & {
  client_id: string;
  client_name: string;
  requested_by_id: string | null;
  requested_by_name: string | null;
  created_at: Date;
};

/** Statuses still needing the account manager to do something. */
const OPEN_STATUSES = ["new", "under_review"] as const;

export async function incomingRequests(
  user: ScopeUser,
  options: { openOnly?: boolean } = {},
  db: Db = prisma,
): Promise<IncomingRequest[]> {
  const scope = await clientScopeWhere(user, db);

  const rows = await db.postRequest.findMany({
    where: {
      ...scope,
      ...(options.openOnly ? { status: { in: [...OPEN_STATUSES] } } : {}),
    },
    // Oldest first, like the review queue and unlike the intake queue: a request
    // sitting unanswered for a week is the one holding a client up, and
    // newest-first would bury it under this morning's.
    orderBy: { created_at: "asc" },
    take: 200,
    select: {
      post_request_id: true,
      client_id: true,
      requested_date: true,
      status: true,
      related_content_item_id: true,
      linked_campaign_id: true,
      created_at: true,
      client: { select: { name: true } },
      requested_by: { select: { user_id: true, name: true } },
      comments: {
        orderBy: { created_at: "asc" },
        select: {
          comment_id: true,
          author_id: true,
          body: true,
          created_at: true,
          author: { select: { name: true } },
        },
      },
    },
  });

  return rows.map((row) => ({
    post_request_id: row.post_request_id,
    client_id: row.client_id,
    client_name: row.client.name,
    requested_by_id: row.requested_by?.user_id ?? null,
    requested_by_name: row.requested_by?.name ?? null,
    requested_date: row.requested_date,
    status: row.status,
    related_content_item_id: row.related_content_item_id,
    linked_campaign_id: row.linked_campaign_id,
    created_at: row.created_at,
    comments: row.comments.map((comment) => ({
      comment_id: comment.comment_id,
      author_id: comment.author_id,
      author_name: comment.author?.name ?? null,
      body: comment.body,
      created_at: comment.created_at,
    })),
    client_editable: row.status === CLIENT_EDITABLE_STATUS,
  }));
}

/** An incoming request, ready to cross into a client component. */
export function serializeIncomingRequest(request: IncomingRequest) {
  return {
    post_request_id: request.post_request_id,
    client_id: request.client_id,
    client_name: request.client_name,
    requested_by_id: request.requested_by_id,
    requested_by_name: request.requested_by_name,
    requested_date: request.requested_date.toISOString(),
    status: request.status,
    related_content_item_id: request.related_content_item_id,
    linked_campaign_id: request.linked_campaign_id,
    created_at: request.created_at.toISOString(),
    client_editable: request.client_editable,
    comments: request.comments.map((comment) => ({
      comment_id: comment.comment_id,
      author_id: comment.author_id,
      author_name: comment.author_name,
      body: comment.body,
      created_at: comment.created_at.toISOString(),
    })),
  };
}

export type IncomingRequestSerialized = ReturnType<typeof serializeIncomingRequest>;
