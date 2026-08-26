"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "../../../components/Page";

/**
 * Handing produced items to the creators who will finish them.
 *
 * The picker offers only creators holding `content_creator` on this client --
 * the same rule `taskAssignment` enforces on the write path. Offering anyone
 * else would produce a refusal the lead could not have predicted, and the server
 * re-checks regardless, so this is a courtesy rather than the guard.
 *
 * Assignment is dispatch, not permission: it does not change the item's status,
 * does not affect either approval stage, and does not widen what the assignee
 * can see. An unassigned item is still reviewable and still publishable.
 */

type AssignableItem = {
  content_item_id: string;
  content_form: string;
  platform: string | null;
  status: string;
  assigned_to_id: string | null;
};

export function AssignPanel({
  items,
  creators,
}: {
  items: AssignableItem[];
  creators: { user_id: string; name: string }[];
}) {
  return (
    <div className="rounded-2xl border border-edge bg-surface p-4">
      <h2 className="mb-1 font-heading text-sm font-semibold text-heading">Hand off</h2>
      <p className="mb-3 text-xs text-body">
        Assigning an item says who is expected to work on it. It changes nothing about review or
        approval.
      </p>

      {creators.length === 0 ? (
        <p className="text-sm text-body">
          No creators are assigned to this client yet, so there is nobody to hand work to.
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <AssignRow key={item.content_item_id} item={item} creators={creators} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AssignRow({
  item,
  creators,
}: {
  item: AssignableItem;
  creators: { user_id: string; name: string }[];
}) {
  const router = useRouter();

  const [assignee, setAssignee] = useState(item.assigned_to_id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function assign(next: string) {
    setBusy(true);
    setError(null);
    const previous = assignee;
    setAssignee(next);

    try {
      const response = await fetch(`/api/content-items/${item.content_item_id}/assign`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignee_id: next === "" ? null : next }),
      });

      if (!response.ok) {
        const json = await response.json();
        setError(json?.error?.message ?? "Could not assign that.");
        setAssignee(previous);
        return;
      }

      router.refresh();
    } catch {
      setError("Could not assign that.");
      setAssignee(previous);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-heading">
          {item.content_form}
          {item.platform ? ` · ${item.platform}` : ""}
        </p>
        <Badge tone={item.status === "flagged" ? "flag" : "neutral"}>{item.status}</Badge>
      </div>

      <div className="flex items-center gap-2">
        <select
          value={assignee}
          onChange={(event) => void assign(event.target.value)}
          disabled={busy}
          className="rounded-xl border border-edge bg-surface px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
          aria-label={`Assign ${item.content_form}`}
        >
          <option value="">Unassigned</option>
          {creators.map((creator) => (
            <option key={creator.user_id} value={creator.user_id}>
              {creator.name}
            </option>
          ))}
        </select>
      </div>

      {error ? (
        <p className="w-full text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}
