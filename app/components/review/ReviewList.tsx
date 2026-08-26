"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { BulkBar, type BulkOutcome } from "./BulkBar";
import { CommentThread } from "./CommentThread";
import { DecisionActions } from "./DecisionActions";
import { ReviewItemCard, statusLabel, type ReviewItemView } from "./ReviewItemCard";
import { RevokeConfirm } from "./RevokeConfirm";

/**
 * The list of items a reviewer is working through.
 *
 * A client component because the actions are interactive, and because the
 * timestamps on each card are formatted in the reader's own locale rather than
 * the server's.
 *
 * The rows themselves are server-rendered data passed straight down. Nothing is
 * fetched here on mount: the queue a reviewer sees is the one `reviewQueue`
 * scoped for them, and a client-side fetch would be a second, unscoped way to
 * ask the same question.
 *
 * Selection lives here rather than on each card, because the bulk action is
 * about the set. It is deliberately **not** in the URL, unlike the filters and
 * the page: a filter is a view worth sharing, a half-made selection of things
 * about to be approved is not, and a link that arrived with eleven items
 * pre-ticked would be a link that approves them for whoever opens it.
 */
export function ReviewList({
  stage,
  items,
}: {
  stage: "internal" | "client";
  items: ReviewItemView[];
}) {
  const router = useRouter();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BulkOutcome | null>(null);

  /**
   * Only what is actually waiting on this stage can be bulk-approved.
   *
   * An already-approved item in the set would turn "approve the plan" into a
   * no-op on some rows and a second approval on others, and an item at the other
   * stage would simply be refused. Offering the checkbox only where the action
   * means something keeps the count on the button honest.
   */
  const selectable = items.filter((item) => item.awaiting_me);

  function toggle(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
    setResult(null);
  }

  async function approveSelected() {
    setBusy(true);
    setResult(null);

    const response = await fetch("/api/approvals/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content_item_ids: [...selected],
        stage,
        decision: "approve",
      }),
    });

    const body = (await response.json().catch(() => ({}))) as BulkOutcome & {
      error?: { message?: string };
    };

    if (!response.ok) {
      setResult({
        succeeded: 0,
        failed: selected.size,
        outcomes: [
          {
            content_item_id: "",
            ok: false,
            message: body.error?.message ?? "That could not be recorded.",
          },
        ],
      });
      setBusy(false);
      return;
    }

    setResult(body);
    setSelected(new Set());
    setBusy(false);
    // Re-read the scoped queue rather than removing rows locally: approving the
    // internal stage moves items to the client's, so what leaves this list is
    // the server's answer, not a guess made here.
    router.refresh();
  }

  return (
    <div>
      {selectable.length > 0 ? (
        <BulkBar
          selectedCount={selected.size}
          totalCount={selectable.length}
          busy={busy}
          result={result}
          onSelectAll={() => {
            setSelected(new Set(selectable.map((i) => i.content_item_id)));
            setResult(null);
          }}
          onClear={() => {
            setSelected(new Set());
            setResult(null);
          }}
          onApprove={approveSelected}
        />
      ) : null}

      <div className="space-y-4">
        {items.map((item) => (
          <ReviewItemCard
            key={item.content_item_id}
            item={item}
            stage={stage}
            selection={
              item.awaiting_me
                ? {
                    checked: selected.has(item.content_item_id),
                    onChange: (checked) => toggle(item.content_item_id, checked),
                  }
                : undefined
            }
            thread={
              <CommentThread
                contentItemId={item.content_item_id}
                initialComments={item.comments}
                statusLabel={statusLabel(item.status)}
              />
            }
            actions={
              <DecisionActions
                item={item}
                stage={stage}
                // Only where a decision would pull back an approval already
                // given. Everywhere else the plain decline stands, because
                // asking twice about an ordinary rejection is friction with
                // nothing behind it.
                renderRevoke={
                  item.late_revoke
                    ? ({ busy, onConfirm }) => (
                        <RevokeConfirm
                          item={item}
                          stage={stage}
                          busy={busy}
                          onConfirm={onConfirm}
                        />
                      )
                    : undefined
                }
              />
            }
          />
        ))}
      </div>
    </div>
  );
}
