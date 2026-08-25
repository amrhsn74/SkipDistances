import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { enforce } from "@/domain/permissions";
import {
  ReferenceValidationError,
  storeReferences,
  type IncomingReference,
} from "@/domain/referenceAttachments";
import { prisma } from "@/db";
import { regenerateItem } from "@/engine/regenerateItem";

/**
 * Item-level regeneration over HTTP.
 *
 * The same shell as the other Phase 4 routes -- resolve who is asking, check the
 * capability, hand the work to the domain and engine layers, map a thrown error
 * to a status. Nothing about grounding, the on-task refusal, or the approval
 * reset is decided here; that is all `regenerateItem`'s.
 *
 * Two things this route does that the others do not.
 *
 * It reads a multipart body rather than JSON, because the creator may attach a
 * reference image or document alongside the prompt. A request with no files is
 * still valid -- a prompt on its own is the common case -- so the parsing
 * tolerates either.
 *
 * And it checks two capabilities rather than one. `content.regenerate` is the
 * action; `content.attach_reference` is checked separately, and only when files
 * are actually present, because the architecture grants attaching to the content
 * creator alone while a content lead may regenerate without it. Folding them
 * into one check would either hand the lead an attachment power they should not
 * have, or refuse them a regeneration they should.
 */

// Reads the session cookie and writes. Never cached.
export const dynamic = "force-dynamic";

/**
 * POST /api/content-items/[id]/regenerate
 *
 * Accepts `multipart/form-data` with a `prompt` field, zero or more `files`, and
 * an optional parallel `instructions` field per file.
 *
 * Answers 200 rather than 201: the content item already existed, and this
 * replaced its draft in place. A regeneration whose result is flagged is still a
 * 200 -- the engine ran and reached a verdict, which is a successful request
 * with an unwelcome answer, exactly as a flagged intake is a 201 on
 * `/api/campaigns`. The caller branches on `compliance.outcome.decision`.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();

    const contentItemId = params.id;

    // The capability is client-scoped, so the item has to be resolved to its
    // client before the check can mean anything. Selected narrowly -- this is
    // the permission lookup, not the regeneration's own read of the item, which
    // `regenerateItem` does for itself.
    const clientId = await clientOf(contentItemId);

    // An unknown item is passed through as a null client and denied by scope,
    // which is the correct answer: a caller must not learn from the status code
    // whether an item they cannot see happens to exist.
    await enforce(user, "content.regenerate", { clientId: clientId ?? undefined });

    const { prompt, files } = await readBody(request);

    if (files.length > 0) {
      // Only when files are actually attached -- see the note above.
      await enforce(user, "content.attach_reference", { clientId: clientId ?? undefined });
    }

    // Stored before the engine runs, so the rows exist whatever the engine
    // decides. The ERD requires attachments to accumulate across regenerations
    // rather than being overwritten: a reference that produced a *flagged*
    // result is exactly the one a reviewer needs to see, so a refusal must not
    // erase it.
    const stored = await storeReferences(contentItemId, files, user.user_id);

    const result = await regenerateItem(contentItemId, {
      prompt,
      // Omitted when nothing was attached, which is not the same as an empty
      // list: `regenerateItem` falls back to the item's existing attachments,
      // so a re-prompt keeps the reference material already on file.
      ...(stored.length > 0 ? { references: stored } : {}),
      requestedById: user.user_id,
    });

    return NextResponse.json({
      content_item_id: result.contentItemId,
      status: result.status,
      decision: result.compliance.outcome.decision,
      item: result.item,
      compliance: result.compliance,
      reference_ids: result.referenceIds,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** The client this item belongs to, or null if there is no such item. */
async function clientOf(contentItemId: string): Promise<string | null> {
  const item = await prisma.contentItem.findUnique({
    where: { content_item_id: contentItemId },
    select: { campaign: { select: { client_id: true } } },
  });
  return item?.campaign.client_id ?? null;
}

/**
 * The multipart body, as a prompt and a list of files.
 *
 * Each file may carry its own instruction: `instructions` is read positionally,
 * so the nth `instructions` entry belongs to the nth file. A form that sends
 * files without instructions is fine -- the field is optional per the ERD.
 *
 * A body that is not multipart at all is refused as a validation error rather
 * than a 500, since posting JSON here is a plausible caller mistake.
 */
async function readBody(
  request: Request,
): Promise<{ prompt: string; files: IncomingReference[] }> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ReferenceValidationError({
      body: "Send this as multipart/form-data with a prompt and any reference files.",
    });
  }

  const prompt = typeof form.get("prompt") === "string" ? (form.get("prompt") as string) : "";
  if (prompt.trim() === "") {
    // Checked here rather than left to the engine: an empty prompt would reach
    // `checkOnTask`, which would spend a Gemini call to refuse nothing at all.
    throw new ReferenceValidationError({ prompt: "A regeneration needs a prompt." });
  }

  const instructions = form
    .getAll("instructions")
    .map((value) => (typeof value === "string" ? value : ""));

  const files: IncomingReference[] = [];
  const entries = form.getAll("files").filter((value): value is File => value instanceof File);

  for (const [index, file] of entries.entries()) {
    files.push({
      filename: file.name,
      mimeType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
      instruction: instructions[index] ?? null,
    });
  }

  return { prompt, files };
}
