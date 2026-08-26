"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { ACCEPTED_MIME_TYPES } from "@/domain/referenceTypes";
import type { CreatorItemSerialized } from "@/domain/creatorQueue";

/**
 * Prompting the engine to redraft one item, with the creator's own references.
 *
 * The file picker's `accept` list comes from `referenceTypes`, the same module
 * the server validates against. That is the point of importing it rather
 * than typing the list here: PRD §4 puts video references out of scope, and two
 * copies of an allowlist is how a browser ends up offering a format the server
 * then refuses. The client-side check is a courtesy -- `storeReferences`
 * re-validates every file, and a request assembled by hand is refused there.
 *
 * The prompt is checked for emptiness before the round trip for a reason worth
 * more than tidiness: an empty prompt would reach `checkOnTask` and spend a
 * Gemini call refusing nothing.
 *
 * **A refusal is a normal outcome here, not an error.** The engine answers 200
 * with a flagged verdict when a regeneration breaks a rule, and 422 when the
 * prompt was off-task. Both are shown as what they are -- the engine ran and
 * reached an answer -- rather than as something that went wrong, because a
 * creator whose reference produced a flagged draft needs the clause, not a
 * failure toast.
 */
export function RegeneratePanel({ item }: { item: CreatorItemSerialized }) {
  const router = useRouter();

  const fileInput = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [instructions, setInstructions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ decision: string; note: string } | null>(null);

  function chooseFiles(list: FileList | null) {
    const chosen = Array.from(list ?? []);

    // Refused here as well as on the server, so a creator who picks a video
    // learns immediately rather than after an upload.
    const rejected = chosen.filter((file) => !ACCEPTED_MIME_TYPES.includes(file.type));
    if (rejected.length > 0) {
      setError(
        `${rejected.map((f) => f.name).join(", ")} — attach an image, a PDF, or a document. ` +
          `Video references are out of scope.`,
      );
    } else {
      setError(null);
    }

    const accepted = chosen.filter((file) => ACCEPTED_MIME_TYPES.includes(file.type));
    setFiles(accepted);
    setInstructions(accepted.map(() => ""));
  }

  async function regenerate(event: React.FormEvent) {
    event.preventDefault();

    if (prompt.trim() === "") {
      setError("Say what you want changed.");
      return;
    }

    setBusy(true);
    setError(null);
    setOutcome(null);

    const form = new FormData();
    form.set("prompt", prompt);
    files.forEach((file, index) => {
      form.append("files", file);
      // Positional: the nth instruction belongs to the nth file, which is what
      // the route reads. Always appended, even when blank, so the two lists
      // cannot slip out of step.
      form.append("instructions", instructions[index] ?? "");
    });

    const response = await fetch(`/api/content-items/${item.content_item_id}/regenerate`, {
      method: "POST",
      body: form,
    });

    const result = (await response.json().catch(() => ({}))) as {
      decision?: string;
      status?: string;
      compliance?: { outcome?: { clause_code?: string; reason?: string } };
      error?: { message?: string; issues?: Record<string, string> };
    };

    if (!response.ok) {
      // 422 with a `prompt` issue is the off-task refusal: the creator is
      // permitted, this particular prompt was not about the client's content.
      setError(result.error?.issues?.prompt ?? result.error?.message ?? "That could not run.");
      setBusy(false);
      return;
    }

    setBusy(false);

    if (result.decision === "DRAFT") {
      setOutcome({ decision: "DRAFT", note: "Redrafted. The new version is below." });
      setPrompt("");
      setFiles([]);
      setInstructions([]);
      if (fileInput.current) fileInput.current.value = "";
      router.refresh();
      return;
    }

    // Flagged or sent back for information. The engine ran and answered; the
    // clause is what the creator needs, not a failure message.
    setOutcome({
      decision: result.decision ?? "FLAG",
      note:
        result.compliance?.outcome?.reason ??
        "The result broke a rule, so the draft was left as it was.",
    });
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="skip-btn skip-btn-secondary"
      >
        Regenerate with a prompt
      </button>
    );
  }

  return (
    <form onSubmit={regenerate}>
      <label htmlFor={`prompt-${item.content_item_id}`} className="skip-label">
        What should change?
      </label>
      <textarea
        id={`prompt-${item.content_item_id}`}
        required
        rows={3}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Shorter, and lead with the offer rather than the season."
        className="skip-input resize-y"
      />

      <div className="mt-3">
        <label htmlFor={`files-${item.content_item_id}`} className="skip-label">
          Reference material{" "}
          <span className="font-normal text-body/70">
            (optional — image, PDF, or document)
          </span>
        </label>
        <input
          id={`files-${item.content_item_id}`}
          ref={fileInput}
          type="file"
          multiple
          accept={ACCEPTED_MIME_TYPES.join(",")}
          onChange={(e) => chooseFiles(e.target.files)}
          className="skip-input file:mr-3 file:rounded-full file:border-0 file:bg-canvas file:px-3 file:py-1 file:text-sm file:font-semibold"
        />
        <p className="mt-1 text-xs text-body/70">
          {/*
            Stated where the file is chosen, because this is where the
            expectation forms. A reference shapes how a draft looks or what it
            knows; it never makes a disallowed claim draftable.
          */}
          An image guides how it looks; a document guides what it says. Neither
          overrides a rule — a reference can&rsquo;t make a disallowed claim
          allowed.
        </p>
      </div>

      {files.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {files.map((file, index) => (
            <li key={file.name} className="rounded-xl bg-canvas px-4 py-3">
              <p className="text-sm font-semibold text-heading">{file.name}</p>
              <label htmlFor={`instruction-${item.content_item_id}-${index}`} className="sr-only">
                Instruction for {file.name}
              </label>
              <input
                id={`instruction-${item.content_item_id}-${index}`}
                value={instructions[index] ?? ""}
                onChange={(e) =>
                  setInstructions((current) => {
                    const next = [...current];
                    next[index] = e.target.value;
                    return next;
                  })
                }
                placeholder="What should this reference do? e.g. match this angle"
                className="skip-input mt-2"
              />
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy} className="skip-btn skip-btn-primary">
          {busy ? "Redrafting…" : "Regenerate"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
            setOutcome(null);
          }}
          disabled={busy}
          className="skip-btn skip-btn-secondary"
        >
          Cancel
        </button>
      </div>

      {outcome ? (
        <p
          role="status"
          className={
            outcome.decision === "DRAFT"
              ? "mt-3 rounded-lg bg-ok-bg px-3 py-2 text-sm text-ok"
              : "mt-3 rounded-lg bg-flag-bg px-3 py-2 text-sm text-flag"
          }
        >
          {outcome.note}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}
