import { notFound } from "next/navigation";

import { currentUser } from "@/api/request";
import { prisma } from "@/db";
import { loadConversation } from "@/domain/conversations";

import { Badge, Card, PageHeader } from "../../../components/Page";

/**
 * A conversation, read by the agency admin for conduct review.
 *
 * This is what `off_task_generation` was always missing. The flag itself carries
 * a 500-character excerpt of the refused prompt -- enough to rank a queue row,
 * not enough to judge a person. Here the whole thread is visible, so the
 * difference between someone who typed one odd thing and someone who spent nine
 * turns trying to get the tool to write their CV is a difference the Admin can
 * actually see.
 *
 * Read-only, deliberately. The Admin resolves the flag on the governance queue;
 * this screen is the evidence behind that decision and offers no action of its
 * own, so oversight cannot quietly become participation.
 *
 * Access is `loadConversation`'s -- the admin flag is what grants it, and no
 * other role reaches another person's thread.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Conversation · Skip Studio" };

export default async function Page({ params }: { params: { id: string } }) {
  // Non-null: the layout has already called `requireRole`.
  const user = (await currentUser())!;

  let conversation;
  try {
    conversation = await loadConversation(user, params.id);
  } catch {
    notFound();
  }

  const [client, author, flags] = await Promise.all([
    prisma.client.findUnique({
      where: { client_id: conversation.client_id },
      select: { name: true },
    }),
    conversation.created_by_id
      ? prisma.user.findUnique({
          where: { user_id: conversation.created_by_id },
          select: { name: true, email: true },
        })
      : Promise.resolve(null),
    // The flags raised from this thread, so a refused turn can show why it was
    // refused rather than only that it was.
    prisma.flag.findMany({
      where: {
        flag_id: {
          in: conversation.turns
            .map((turn) => turn.flag_id)
            .filter((id): id is string => Boolean(id)),
        },
      },
      select: { flag_id: true, details: true, resolved: true },
    }),
  ]);

  const reasonFor = new Map(
    flags.map((flag) => {
      let reason: string | null = null;
      try {
        reason = (JSON.parse(flag.details ?? "{}") as { reason?: string }).reason ?? null;
      } catch {
        reason = null;
      }
      return [flag.flag_id, { reason, resolved: flag.resolved }];
    }),
  );

  return (
    <>
      <PageHeader
        title="Conversation"
        description={`${author?.name ?? "Unknown user"} · ${client?.name ?? conversation.client_id}`}
      />

      <Card>
        <ul className="space-y-4">
          {conversation.turns.map((turn) => {
            const flagged = turn.flag_id ? reasonFor.get(turn.flag_id) : undefined;

            return (
              <li key={turn.turn_id} className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-body">
                    {turn.role}
                  </span>
                  <span className="text-xs text-body">
                    {turn.created_at.toLocaleString()}
                  </span>
                  {flagged ? (
                    <Badge tone={flagged.resolved ? "neutral" : "danger"}>
                      {flagged.resolved ? "refused · resolved" : "refused"}
                    </Badge>
                  ) : null}
                </div>

                <p
                  className={[
                    "whitespace-pre-wrap rounded-xl border px-4 py-3 text-sm",
                    flagged
                      ? "border-danger/30 bg-danger-bg text-heading"
                      : "border-edge bg-canvas text-heading",
                  ].join(" ")}
                >
                  {turn.body}
                </p>

                {flagged?.reason ? (
                  <p className="text-xs text-body">
                    The engine took this to be: {flagged.reason}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Card>
    </>
  );
}
