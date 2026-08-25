import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { REFERENCE_UPLOADS_DIR } from "../config/paths";
import { prisma, type Db } from "../db";
import { writeAudit } from "./auditLog";

/**
 * Reference material a creator supplies when prompting a regeneration.
 *
 * `regenerateItem` consumes `RegenerationReference` rows; it does not create
 * them. Something has to turn an uploaded file into bytes on disk and a
 * `ReferenceAttachment` row first, and that something is here rather than in the
 * route handler -- the same reason `submitBrief` exists next to `runIntake`.
 *
 * Three rules live in this file, and all three are rules rather than plumbing:
 * which file types are admissible (PRD §4 -- image or PDF/doc, never video),
 * that an attachment belongs to exactly the one `ContentItem` it was supplied
 * for (ERD), and that rows accumulate across regenerations rather than being
 * overwritten, so a reviewer can see which reference produced which version.
 */

/**
 * Image, PDF, or doc. No video.
 *
 * The PRD puts video references out of scope explicitly, so this is a closed
 * allowlist rather than a denylist: an unrecognised type is refused, which means
 * a format nobody considered fails closed instead of reaching the model.
 */
const ACCEPTED_TYPES = {
  "image/jpeg": { fileType: "image", extension: ".jpg" },
  "image/png": { fileType: "image", extension: ".png" },
  "image/webp": { fileType: "image", extension: ".webp" },
  "application/pdf": { fileType: "pdf", extension: ".pdf" },
  "text/plain": { fileType: "doc", extension: ".txt" },
  "text/markdown": { fileType: "doc", extension: ".md" },
  "application/msword": { fileType: "doc", extension: ".doc" },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    fileType: "doc",
    extension: ".docx",
  },
} as const satisfies Record<string, { fileType: "image" | "pdf" | "doc"; extension: string }>;

/** What the UI's file picker should offer, so client and server agree. */
export const ACCEPTED_MIME_TYPES = Object.keys(ACCEPTED_TYPES);

export class ReferenceValidationError extends Error {
  readonly code = "REFERENCE_VALIDATION";
  /** Field-keyed so a regenerate form can show each message against its input. */
  readonly issues: Record<string, string>;

  constructor(issues: Record<string, string>) {
    super(`Invalid reference: ${Object.keys(issues).join(", ")}.`);
    this.name = "ReferenceValidationError";
    this.issues = issues;
  }
}

/** One uploaded file, already read off the multipart body. */
export type IncomingReference = {
  filename: string;
  mimeType: string;
  bytes: Buffer;
  /** Optional text accompanying this file, e.g. "match this angle". */
  instruction?: string | null;
};

export type StoredReference = {
  attachment_id: string;
  content_item_id: string;
  file_type: string;
  storage_url: string;
  instruction: string | null;
};

/**
 * Persist uploaded reference files against one content item.
 *
 * Writes bytes to `public/uploads/references` and one row per file. Returns the
 * rows in exactly the shape `regenerateItem` expects, so the caller passes them
 * straight through without re-mapping.
 *
 * The item is looked up rather than assumed: `content_item_id` is a foreign key,
 * and an FK failure surfaces as a 500 with a Prisma message when "no such item"
 * is a caller error a form should be able to show.
 */
export async function storeReferences(
  contentItemId: string,
  files: IncomingReference[],
  uploadedById: string,
  db: Db = prisma,
): Promise<StoredReference[]> {
  if (files.length === 0) return [];

  const item = await db.contentItem.findUnique({
    where: { content_item_id: contentItemId },
    select: { content_item_id: true },
  });
  if (!item) {
    throw new ReferenceValidationError({
      contentItemId: `No content item ${contentItemId}.`,
    });
  }

  // Validated as a batch before a single byte is written, so a request carrying
  // one good file and one video does not leave the good half on disk and half a
  // regeneration's worth of context behind.
  const issues: Record<string, string> = {};
  files.forEach((file, index) => {
    const accepted = ACCEPTED_TYPES[file.mimeType as keyof typeof ACCEPTED_TYPES];
    if (!accepted) {
      issues[`files.${index}`] =
        `${file.filename || "This file"} is a ${file.mimeType || "unknown"} file. ` +
        `Attach an image, a PDF, or a document.`;
      return;
    }
    if (file.bytes.length === 0) {
      issues[`files.${index}`] = `${file.filename || "This file"} is empty.`;
    }
  });
  if (Object.keys(issues).length > 0) throw new ReferenceValidationError(issues);

  await mkdir(REFERENCE_UPLOADS_DIR, { recursive: true });

  const stored: StoredReference[] = [];
  for (const file of files) {
    const accepted = ACCEPTED_TYPES[file.mimeType as keyof typeof ACCEPTED_TYPES];

    // A generated name, never the uploaded one. An attacker-supplied filename is
    // a path traversal waiting to happen, and two creators attaching "ref.jpg"
    // to different items must not collide.
    const storageUrl = path.join(
      REFERENCE_UPLOADS_DIR,
      `${contentItemId}-${randomUUID()}${accepted.extension}`,
    );
    await writeFile(storageUrl, file.bytes);

    const instruction = (file.instruction ?? "").trim() || null;

    const row = await db.referenceAttachment.create({
      data: {
        content_item_id: contentItemId,
        uploaded_by_id: uploadedById,
        file_type: accepted.fileType,
        // An absolute path, because `regenerateItem` reads it with `readFile`
        // rather than serving it. Phase 7's history view derives the public
        // `/uploads/...` URL from the basename.
        storage_url: storageUrl,
        instruction,
      },
      select: {
        attachment_id: true,
        content_item_id: true,
        file_type: true,
        storage_url: true,
        instruction: true,
      },
    });

    await writeAudit(
      {
        entityType: "ReferenceAttachment",
        entityId: row.attachment_id,
        action: "created",
        performedById: uploadedById,
        details: {
          content_item_id: contentItemId,
          file_type: row.file_type,
          bytes: file.bytes.length,
        },
      },
      db,
    );

    stored.push(row);
  }

  return stored;
}
