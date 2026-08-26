import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { MEDIA_UPLOADS_DIR } from "../config/paths";
import { prisma, type Db } from "../db";
import { writeAudit } from "./auditLog";

/**
 * Media hung off a content item.
 *
 * The `ContentItem.content_body` comment states the rule this file implements:
 * "Visual/video forms carry their content via linked MediaAsset rows instead."
 * Until now nothing created those rows, so an `image` item was a paragraph
 * describing a picture that did not exist.
 *
 * Two things live here rather than in the engine. First, where bytes go and what
 * URL names them -- a storage decision, not a generation one, and the thing that
 * changes first if this ever moves off local disk. Second, that a stored asset
 * is always audited, because an AI-generated image that nobody can trace to a
 * prompt and a moment is exactly the artefact an agency cannot defend.
 *
 * Deliberately not a rule here: whether an item *should* have an image. That is
 * `content_form`'s business and is decided in `generateMedia`.
 */

/** The forms that carry their content as pixels rather than prose. */
export const VISUAL_FORMS = ["image", "video", "reel", "photoshoot"] as const;

export type VisualForm = (typeof VISUAL_FORMS)[number];

export function isVisualForm(form: string): form is VisualForm {
  return (VISUAL_FORMS as readonly string[]).includes(form);
}

/**
 * What a form needs made.
 *
 * `video` and `reel` are moving pictures and Imagen does not make those. Rather
 * than pretend otherwise, they resolve to a still: a key frame is a genuinely
 * useful thing to hand a creator who will shoot the video, and it is honest
 * about what it is. `asset_type` records `image` for them, because that is what
 * the file is -- claiming `video` for a PNG would put a lie in the database.
 */
export const ASSET_TYPE_FOR_FORM: Record<VisualForm, "image" | "video"> = {
  image: "image",
  reel: "image",
  video: "image",
  photoshoot: "image",
};

/** Aspect ratio each form is usually cut to. */
export const ASPECT_FOR_FORM: Record<VisualForm, string> = {
  image: "1:1",
  // Vertical, because that is what a reel and a story are.
  reel: "9:16",
  video: "16:9",
  photoshoot: "4:3",
};

const EXTENSION_FOR_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

export class MediaAssetError extends Error {
  readonly code = "MEDIA_ASSET";
  constructor(message: string) {
    super(message);
    this.name = "MediaAssetError";
  }
}

export type IncomingMedia = {
  bytes: Buffer;
  mimeType: string;
  assetType: "image" | "video";
  generationSource: "ai_generated" | "uploaded";
  /** The prompt an AI asset was made from. Audited, not stored on the row. */
  prompt?: string | null;
  /** Null for AI output -- no person made it. */
  createdById?: string | null;
};

export type StoredMedia = {
  media_asset_id: string;
  content_item_id: string;
  asset_type: string;
  generation_source: string;
  storage_url: string;
  format: string | null;
};

/**
 * Write bytes to disk and file one `MediaAsset` row against a content item.
 *
 * Unlike `storeReferences`, `storage_url` here is the *public* path, not an
 * absolute one. A reference is read back off disk by the regeneration engine; a
 * generated image is only ever served to a browser, and storing an absolute
 * Windows path in a field the UI puts in `src=` is how you ship a broken image
 * that works on one machine.
 */
export async function storeMedia(
  contentItemId: string,
  media: IncomingMedia,
  db: Db = prisma,
): Promise<StoredMedia> {
  if (media.bytes.length === 0) {
    throw new MediaAssetError("Refusing to store an empty media file.");
  }

  const item = await db.contentItem.findUnique({
    where: { content_item_id: contentItemId },
    select: { content_item_id: true },
  });
  if (!item) {
    throw new MediaAssetError(`No content item ${contentItemId}.`);
  }

  const extension = EXTENSION_FOR_MIME[media.mimeType] ?? ".png";

  await mkdir(MEDIA_UPLOADS_DIR, { recursive: true });

  const filename = `${contentItemId}-${randomUUID()}${extension}`;
  await writeFile(path.join(MEDIA_UPLOADS_DIR, filename), media.bytes);

  // Forward slashes, always. `path.join` would give backslashes on Windows and
  // a browser does not read those as separators.
  const storageUrl = `/uploads/media/${filename}`;

  const row = await db.mediaAsset.create({
    data: {
      content_item_id: contentItemId,
      asset_type: media.assetType,
      generation_source: media.generationSource,
      storage_url: storageUrl,
      format: media.mimeType,
      created_by_id: media.createdById ?? null,
    },
    select: {
      media_asset_id: true,
      content_item_id: true,
      asset_type: true,
      generation_source: true,
      storage_url: true,
      format: true,
    },
  });

  await writeAudit(
    {
      entityType: "MediaAsset",
      entityId: row.media_asset_id,
      action: "created",
      performedById: media.createdById ?? null,
      details: {
        content_item_id: contentItemId,
        asset_type: media.assetType,
        generation_source: media.generationSource,
        bytes: media.bytes.length,
        // The prompt is the whole provenance story for a generated image, and
        // the audit log is the only place it is kept.
        ...(media.prompt ? { prompt: media.prompt } : {}),
      },
    },
    db,
  );

  return row;
}
