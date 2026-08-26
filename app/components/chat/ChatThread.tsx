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

/** One item the engine offered to draft. Nothing exists for it yet. */
export type ProposedItem = {
  title: string;
  content_form: string;
  platform: string | null;
  summary: string | null;
  clause_codes: string[];
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

  // The engine's current offer, and what the creator has ticked on it. Held
  // together because a selection means nothing without the list it indexes into
  // -- clearing one always clears the other.
  const [proposal, setProposal] = useState<ProposedItem[] | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());

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

  /**
   * Send a turn.
   *
   * `selection` is passed only when the creator is answering a proposal, and it
   * is what turns an offer into actual drafted work. An ordinary message carries
   * none, which is why a complete thread proposes instead of drafting.
   */
  async function send(selection?: number[]) {
    const text = selection ? (prompt.trim() || "Draft the selected items.") : prompt.trim();
    // Checked before the round trip: an empty turn would reach the engine and
    // spend a call refusing nothing. A selection carries its own text, so it is
    // never empty.
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
        body: JSON.stringify(selection ? { prompt: text, selection } : { prompt: text }),
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

      // An offer replaces any previous one, and always with an empty tick list:
      // indices from an older proposal would silently point at different items.
      if (json.status === "proposed") {
        setProposal(json.items ?? []);
        setChosen(new Set());
      } else {
        // Anything else -- drafted, refused, another question -- retires the
        // offer. Leaving it on screen would invite a creator to tick a list the
        // server has already moved past.
        setProposal(null);
        setChosen(new Set());
      }

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
    // `min-h-0` on both the column and the scroller is what stops the thread
    // collapsing when something is added below it.
    //
    // The container is a fixed-height flex column, and a flex child's default
    // `min-height: auto` refuses to shrink below its content. So when a produced
    // item or a proposal appeared, the transcript could not give up any height
    // and the whole layout was squeezed instead -- the bug that made the UI
    // appear to collapse the moment content was generated. `min-h-0` lets the
    // transcript shrink and scroll, which is what a transcript should do.
    <div className="flex h-[calc(100vh-13rem)] min-h-0 flex-col gap-4">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-2xl border border-edge bg-surface p-6">
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

      {proposal ? (
        <div className="max-h-[45%] shrink-0 overflow-y-auto">
          <ProposalPicker
            items={proposal}
            chosen={chosen}
            onToggle={(index) =>
              setChosen((current) => {
                const next = new Set(current);
                if (next.has(index)) next.delete(index);
                else next.add(index);
                return next;
              })
            }
            busy={busy}
            onDraft={() => {
              // Ascending, so the engine drafts in the plan's own order rather
              // than in whatever order the boxes were ticked.
              void send([...chosen].sort((a, b) => a - b));
            }}
          />
        </div>
      ) : null}

      {/* Capped and scrollable: a campaign with a dozen items must not push the
          prompt box off the screen. The transcript above keeps the rest. */}
      {items.length > 0 ? (
        <div className="max-h-[40%] shrink-0 overflow-y-auto">
          <ProducedItems items={items} />
        </div>
      ) : null}

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

/**
 * The engine's offer, and the creator's choice.
 *
 * This is where "draft by user" actually lives. Every item shown here is
 * something the engine *would* write; none of it exists yet, and the ones left
 * unticked never will -- they are not generated, not judged, not stored. So the
 * checkbox is not a filter over finished work, it is the decision about what
 * work happens at all.
 *
 * The clauses each item would be written under are shown before the choice
 * rather than after, because they are what the choice turns on: picking the
 * LinkedIn item over the Instagram one is picking which rules apply.
 */
function ProposalPicker({
  items,
  chosen,
  onToggle,
  onDraft,
  busy,
}: {
  items: ProposedItem[];
  chosen: Set<number>;
  onToggle: (index: number) => void;
  onDraft: () => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-2xl border border-amber-brand bg-surface p-4">
      <h2 className="mb-1 font-heading text-sm font-semibold text-heading">
        Choose what to draft
      </h2>
      <p className="mb-3 text-xs text-body">
        Nothing is written until you pick. Unticked items are never generated.
      </p>

      <ul className="space-y-2">
        {items.map((item, index) => (
          <li key={`${item.title}-${index}`}>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-edge px-4 py-3 hover:bg-canvas">
              <input
                type="checkbox"
                className="mt-1 shrink-0"
                checked={chosen.has(index)}
                onChange={() => onToggle(index)}
                disabled={busy}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-heading">{item.title}</span>
                <span className="block text-xs text-body">
                  {item.content_form}
                  {item.platform ? ` · ${item.platform}` : ""}
                </span>
                {item.summary ? (
                  <span className="mt-1 block text-xs text-body">{item.summary}</span>
                ) : null}
                {item.clause_codes.length > 0 ? (
                  <span className="mt-1 block text-xs text-body">
                    Would cite {item.clause_codes.join(", ")}
                  </span>
                ) : null}
              </span>
            </label>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={onDraft}
        // Nothing ticked is not a request to draft everything -- it is a request
        // to draft nothing, and the server refuses an empty selection for the
        // same reason. See `planSelection.validateSelection`.
        disabled={busy || chosen.size === 0}
        className="mt-3 rounded-xl bg-amber-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy
          ? "Drafting…"
          : `Draft ${chosen.size} selected item${chosen.size === 1 ? "" : "s"}`}
      </button>
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
    <div className="flex h-16 w-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-edge bg-canvas text-center text-[10px] leading-tight text-body">
      <span aria-hidden="true" className="text-base leading-none">
        ▨
      </span>
      <span>No image</span>
    </div>
  );
}

/** Statuses from which an item can still be sent to internal review. */
const SUBMITTABLE = new Set(["drafted", "in_refinement", "flagged"]);

function ProducedItems({ items }: { items: ProducedItem[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Send one item to internal review.
   *
   * Per item, not per campaign. A creator who drafted three things and is happy
   * with two submits two -- the third stays a draft rather than being carried
   * into review by its neighbours. The server applies the same transition table
   * either way, so a flagged item is still cleared and submitted as two recorded
   * movements; this only chooses which items make the trip.
   */
  async function submit(contentItemId: string) {
    setBusyId(contentItemId);
    setError(null);

    try {
      const response = await fetch(`/api/content-items/${contentItemId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "submit" }),
      });

      if (!response.ok) {
        const json = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(json.error?.message ?? "That could not be submitted.");
        return;
      }

      router.refresh();
    } catch {
      setError("That could not be submitted.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-2xl border border-edge bg-surface p-4">
      <h2 className="mb-1 font-heading text-sm font-semibold text-heading">
        Produced in this conversation
      </h2>
      {/* Submitting is per item and stays a separate, deliberate act from
          generating one -- drafting something is not the same as saying it is
          ready. What changed is only that the creator no longer has to leave the
          thread to say so about one item out of several. */}
      <p className="mb-3 text-xs text-body">
        Submit the ones that are ready, or{" "}
        <Link href="/Creator/assignments" className="text-amber-dark hover:underline">
          refine them in Assignments
        </Link>
        .
      </p>

      {error ? (
        <p className="mb-2 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
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
              {SUBMITTABLE.has(item.status) ? (
                <button
                  type="button"
                  onClick={() => void submit(item.content_item_id)}
                  disabled={busyId === item.content_item_id}
                  className="rounded-lg border border-edge px-3 py-1 text-xs font-medium text-heading hover:bg-canvas disabled:opacity-50"
                >
                  {busyId === item.content_item_id ? "Submitting…" : "Submit"}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

