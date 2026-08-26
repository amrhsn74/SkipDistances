"use client";

import { CreatorItemCard } from "./CreatorItemCard";
import { DraftEditor } from "./DraftEditor";
import { HistoryPanel } from "./HistoryPanel";
import { RegeneratePanel } from "./RegeneratePanel";
import type { CreatorItemSerialized } from "@/domain/creatorQueue";

/**
 * The creator's working list.
 *
 * A thin wrapper for now -- the editing, regeneration and history controls each
 * arrive as their own component in the tasks that follow, and each hangs off one
 * card. Kept as a component rather than mapped inline on the page so those
 * controls have somewhere to be wired that is already a client boundary.
 */
export function CreatorList({ items }: { items: CreatorItemSerialized[] }) {
  return (
    <div className="space-y-4">
      {items.map((item) => (
        <CreatorItemCard
          key={item.content_item_id}
          item={item}
          // Only where the item is actually the creator's to change. An item in
          // review still renders, without controls -- the card says why.
          editor={item.editable ? <DraftEditor item={item} /> : undefined}
          regenerate={<RegeneratePanel item={item} />}
          history={
            <HistoryPanel
              contentItemId={item.content_item_id}
              referenceCount={item.reference_count}
            />
          }
        />
      ))}
    </div>
  );
}
