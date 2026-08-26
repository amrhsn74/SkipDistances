"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Badge } from "../Page";
import { ACCEPTED_MIME_TYPES } from "@/domain/referenceTypes";

import {
  PromptInput,
  PromptInputActions,
  PromptInputAttach,
  PromptInputSubmit,
  PromptInputTextarea,
} from "./PromptInput";

/**
 * The conversation itself.
 *
 * Shared by the creator and the content lead rather than written twice. The two
 * screens differ in what they list -- a lead's threads span clients, a creator's
 * do not -- but a turn is a turn, and a second copy of this would be the place
 * the two drift.
 *
 * **A refusal is a normal outcome here, not an error.** The route answers 200
 * with `status: "refused"`, and it is rendered as the engine's answer rather
 * than as something that went wrong. A creator whose prompt drifted off-task
 * needs to see what the engine took it to be about -- the same text the Admin
 * sees on the flag -- not a red toast.
 *
 * The same applies to a question. `status: "asking"` is the engine holding the
 * line on Clause 0.5, and it is shown as an ordinary turn, because that is what
 * it is: nothing is missing except something the creator has not said yet.
 */

export type Turn = {
  turn_id: string;
  role: string;
  body: string;
  flag_id: string | null;
  created_at: string;
};

export type ProducedMedia = {
  media_asset_id: string;
  asset_type: string;
  storage_url: string;
  generation_source: string;
};

export type ProducedItem = {
  content_item_id: string;
  content_form: string;
  platform: string | null;
  content_body: string | null;
  status: string;
  citations: string[];
  media: ProducedMedia[];
};

export function ChatThread({
  conversationId,
  initialTurns,
  items,
  clientName,
}: {
  conversationId: string;
  initialTurns: Turn[];
  items: ProducedItem[];
  clientName: string;
}) {
  const router = useRouter();

  // Local turns exist only to show the creator's own message before the server
  // has confirmed it. Everything else comes from `initialTurns`.
  const [pending, setPending] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);

  // The server is the record, and `router.refresh()` re-renders this component
  // with a new `initialTurns`. Holding the transcript in `useState` seeded from
  // that prop looked right and was not: `useState`'s initial value is read once,
  // so every refreshed turn was dropped and the thread appeared to lose messages.
  // Deriving the list on each render is what makes a refresh actually show up.
  const turns = [...initialTurns, ...pending.filter(
    (turn) => !initialTurns.some((existing) => existing.body === turn.body && existing.role === turn.role),
  )];

  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns.length]);

  async function send() {
    const text = prompt.trim();
    // Checked before the round trip: an empty turn would reach the engine and
    // spend a call refusing nothing.
    if (!text || busy) return;

    setBusy(true);
    setError(null);

    // Shown immediately. The server assigns the real id; this one only has to
    // be unique within the render before the refresh replaces it.
    const optimistic: Turn = {
      turn_id: `pending-${Date.now()}`,
      role: "creator",
      body: text,
      flag_id: null,
      created_at: new Date().toISOString(),
    };
    setPending((current) => [...current, optimistic]);
    setPrompt("");

    try {
      const response = await fetch(`/api/conversations/${conversationId}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      });

      const json = await response.json();

      if (!response.ok) {
        setError(json?.error?.message ?? "That did not go through.");
        // Rolled back and the text handed back to the box, so a failed send
        // leaves the creator holding their words rather than losing them.
        setPending((current) => current.filter((t) => t.turn_id !== optimistic.turn_id));
        setPrompt(text);
        // The turn may still have been stored before the failure -- an engine
        // fault happens after the creator's turn is written -- so the server is
        // re-read rather than assumed unchanged.
        router.refresh();
        return;
      }

      setMissing(json.status === "asking" ? (json.missing ?? []) : []);

      // An engine fault comes back as a normal 200 turn, not an error status.
      // Surfaced so the creator knows to try again rather than reading the
      // assistant's apology as a considered answer.
      if (json.status === "failed") {
        setError("The engine could not produce anything from that. Try again.");
      }

      // Confirmed by the server, so the local copy is dropped and the refreshed
      // transcript is the only source.
      setPending((current) => current.filter((t) => t.turn_id !== optimistic.turn_id));

      // The server is the record. Re-reading rather than appending the
      // assistant's reply locally keeps the two from disagreeing about what the
      // thread contains -- including the flag a refused turn now carries.
      router.refresh();
    } catch {
      setError("That did not go through.");
      setPending((current) => current.filter((t) => t.turn_id !== optimistic.turn_id));
      setPrompt(text);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-13rem)] flex-col gap-4">
      <div className="flex-1 space-y-4 overflow-y-auto rounded-2xl border border-edge bg-surface p-6">
        {turns.length === 0 ? (
          <p className="py-12 text-center text-sm text-body">
            Say what you need for {clientName}. The engine works from their brand guide and the
            agency standards, and will ask if anything is missing.
          </p>
        ) : null}

        {turns.map((turn) => (
          <TurnBubble key={turn.turn_id} turn={turn} />
        ))}

        {busy ? (
          <p className="text-sm text-body" role="status">
            Working…
          </p>
        ) : null}

        <div ref={endRef} />
      </div>

      {items.length > 0 ? <ProducedItems items={items} /> : null}

      {missing.length > 0 ? (
        <p className="text-xs text-body">
          Still needed: {missing.join(", ")}. Nothing is drafted until all four are stated.
        </p>
      ) : null}

      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <PromptInput
          value={prompt}
          onValueChange={setPrompt}
          onSubmit={() => void send()}
          isLoading={busy}
          disabled={busy}
        >
          <PromptInputTextarea placeholder={`What do you need for ${clientName}?`} />
          <PromptInputActions className="justify-between px-1 pb-1">
            <PromptInputAttach
              files={files}
              onFiles={setFiles}
              disabled={busy}
              accept={ACCEPTED_MIME_TYPES.join(",")}
            />
            <PromptInputSubmit disabled={busy || prompt.trim() === ""} isLoading={busy} />
          </PromptInputActions>
        </PromptInput>
      </form>
    </div>
  );
}

function TurnBubble({ turn }: { turn: Turn }) {
  const isCreator = turn.role === "creator";
  const refused = turn.flag_id !== null;

  return (
    <div className={isCreator ? "flex justify-end" : "flex justify-start"}>
      <div
        className={[
          "max-w-[42rem] rounded-2xl px-4 py-3 text-sm",
          isCreator ? "bg-amber-brand text-white" : "border border-edge bg-canvas text-heading",
          // A refused turn is marked on the turn itself, so the transcript shows
          // where the thread went wrong rather than only that it did.
          refused ? "ring-2 ring-danger" : "",
        ].join(" ")}
      >
        <p className="whitespace-pre-wrap">{turn.body}</p>
        {refused ? (
          <p className="mt-2 text-xs opacity-90">
            Refused and recorded for the agency admin.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Forms whose content is the picture, not the paragraph. See `mediaAssets.ts`. */
const VISUAL_FORMS = ["image", "video", "reel", "photoshoot"];

/**
 * The item's first image, or an honest placeholder.
 *
 * A visual item with no media is shown as *pending*, not hidden. Image
 * generation is allowed to fail without failing the campaign, so "no picture
 * yet" is a real state the creator can be in -- and silently rendering nothing
 * would make a failed generation look identical to one that was never asked for.
 */
function ItemThumbnail({ item }: { item: ProducedItem }) {
  const image = item.media.find((asset) => asset.asset_type === "image");

  if (image) {
    return (
      // A plain <img>: these are runtime-written files under /public/uploads
      // with no known dimensions, which is exactly the case next/image's
      // optimiser is unhelpful for.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={image.storage_url}
        alt={`Generated visual for ${item.content_form}`}
        className="h-16 w-16 shrink-0 rounded-lg border border-edge object-cover"
      />
    );
  }

  if (!VISUAL_FORMS.includes(item.content_form)) return null;

  return (
    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-dashed border-edge text-center text-[10px] leading-tight text-body">
      No image
    </div>
  );
}

function ProducedItems({ items }: { items: ProducedItem[] }) {
  return (
    <div className="rounded-2xl border border-edge bg-surface p-4">
      <h2 className="mb-1 font-heading text-sm font-semibold text-heading">
        Produced in this conversation
      </h2>
      {/* No submit control here, deliberately. Generating a draft is not the
          same act as saying it is ready, and a button beside a freshly generated
          item invites the two to be confused. The creator refines it in
          Assignments and submits from there -- one deliberate act, which is what
          the reset-on-edit design exists to require. */}
      <p className="mb-3 text-xs text-body">
        <Link href="/Creator/assignments" className="text-amber-dark hover:underline">
          Refine and submit these in Assignments
        </Link>{" "}
        when they are ready for review.
      </p>
      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={item.content_item_id}
            className="flex items-start justify-between gap-4 rounded-xl border border-edge px-4 py-3"
          >
            <ItemThumbnail item={item} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-heading">
                {item.content_form}
                {item.platform ? ` · ${item.platform}` : ""}
              </p>
              {item.content_body ? (
                <p className="mt-1 line-clamp-2 text-xs text-body">{item.content_body}</p>
              ) : null}
              {/* Every item states the rules it was written under -- the same
                  citations the review screen shows, so a creator sees the
                  reasoning before a reviewer does. */}
              {item.citations.length > 0 ? (
                <p className="mt-1 text-xs text-body">
                  Grounded in {item.citations.length} clause
                  {item.citations.length === 1 ? "" : "s"}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge tone={item.status === "flagged" ? "flag" : "neutral"}>{item.status}</Badge>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

