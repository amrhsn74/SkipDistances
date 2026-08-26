/**
 * Which reference file types are admissible.
 *
 * Its own module, with **no imports at all**, because both sides of the network
 * need it: `referenceAttachments.ts` validates uploads against it on the server,
 * and the creator's file picker offers it in the browser. Leaving it in
 * `referenceAttachments.ts` meant a client component importing it also imported
 * `node:fs` and `node:crypto`, which does not build.
 *
 * Two copies of an allowlist is the alternative, and it is the worse one: a
 * browser offering a format the server then refuses is a bug that only shows up
 * after someone has waited for an upload.
 *
 * PRD §4 puts video references out of scope, so this is a closed allowlist
 * rather than a denylist -- a format nobody considered fails closed instead of
 * reaching the model.
 */

export type ReferenceFileType = "image" | "pdf" | "doc";

export const ACCEPTED_TYPES = {
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
} as const satisfies Record<string, { fileType: ReferenceFileType; extension: string }>;

/** What the UI's file picker should offer, so client and server agree. */
export const ACCEPTED_MIME_TYPES = Object.keys(ACCEPTED_TYPES);
