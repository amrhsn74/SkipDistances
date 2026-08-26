import { prisma, type Db } from "../db";
import {
  generateImage,
  ImageGenerationError,
  type GenerateImageOptions,
  type GeneratedImageResult,
} from "../llm/gemini";
import {
  ASPECT_FOR_FORM,
  ASSET_TYPE_FOR_FORM,
  isVisualForm,
  storeMedia,
  type VisualForm,
} from "../domain/mediaAssets";
import type { PersistedDraft } from "./queueOrFlag";

/**
 * Step 9: give visual items something to look at.
 *
 * Runs *after* `queueOrFlag`, and the order is the entire argument for this
 * file. Compliance judges text. An image generated before that judgment would
 * be paid for whether or not the copy it illustrates survived, and a flagged
 * item would arrive with artwork attached -- which reads as approval of the
 * thing that was just refused.
 *
 * So: text is drafted, text is checked, text is persisted, and only what came
 * out the far side as `drafted` gets a picture. Flagged items get nothing. That
 * is not an oversight; it is the point.
 *
 * **Nothing here can fail the campaign.** Every failure is caught per item and
 * reported. A campaign whose copy is sound and whose images did not render is a
 * campaign with a retry button, not a lost one -- the same reasoning that put a
 * try/catch around `submitBrief` in `chatTurn`.
 *
 * What this step does *not* do is check the image against the guidelines. It
 * cannot: every guard in this codebase reads text, and there is no clause-level
 * judgment of a picture anywhere in the system. An image here is grounded only
 * in the prompt derived from already-checked copy, and a human still reviews it
 * downstream. That gap is real and is documented rather than papered over.
 */

export type MediaGenerationOutcome =
  | {
      status: "generated";
      contentItemId: string;
      mediaAssetId: string;
      storageUrl: string;
      prompt: string;
    }
  /** The model declined the prompt. Distinct from a fault: rewording may fix it. */
  | {
      status: "declined";
      contentItemId: string;
      prompt: string;
      reason: string;
    }
  | {
      status: "failed";
      contentItemId: string;
      prompt: string;
      reason: string;
    };

export type GenerateMediaResult = {
  attempted: number;
  outcomes: MediaGenerationOutcome[];
};

export type ImageGenerator = (
  prompt: string,
  options?: GenerateImageOptions,
) => Promise<GeneratedImageResult>;

export type GenerateMediaInput = {
  client: { name: string; industry: string };
  drafted: PersistedDraft[];
};

/**
 * The visual subset of what was drafted.
 *
 * Exported because it is the rule -- "which items get pictures" -- and a rule is
 * worth testing without a network call behind it.
 */
export function visualDrafts(drafted: PersistedDraft[]): PersistedDraft[] {
  return drafted.filter((draft) => isVisualForm(draft.item.content_form));
}

/**
 * Turn a drafted item into an image prompt.
 *
 * Built from the copy that already passed compliance rather than from the raw
 * brief, so the picture is anchored to the words a reviewer approved. The client
 * and industry are named because "a post about a new roast" is a different image
 * for a coffee roaster than for a hardware shop.
 *
 * `creative_prompt` and `photoshoot` items are already written *as* direction to
 * a photographer, so their body is used more or less as-is; the others get a
 * frame built around them.
 */
export function toImagePrompt(
  draft: PersistedDraft,
  client: { name: string; industry: string },
): string {
  const { item } = draft;
  const body = (item.content_body ?? "").trim();
  const subject = body || item.title;

  const parts = [
    `A high-quality ${item.content_form === "photoshoot" ? "photograph" : "marketing visual"}`,
    `for ${client.name}, a ${client.industry} brand.`,
    ``,
    `Subject: ${subject}`,
  ];

  if (item.rationale) parts.push(`Creative direction: ${item.rationale}`);
  if (item.platform) parts.push(`Intended for ${item.platform}.`);

  // Said explicitly because an image model will otherwise cheerfully render
  // lorem-ipsum-shaped glyphs into a marketing visual, and a caption is already
  // carried by `content_body` -- the picture must not duplicate or contradict it.
  parts.push(
    ``,
    `Photographic, professionally lit, brand-appropriate. Do not render any text, ` +
      `words, letters, logos or watermarks in the image.`,
  );

  return parts.join("\n");
}

/**
 * Generate and attach one image per visual drafted item.
 *
 * `generate` is injected for the same reason every other engine step injects its
 * model call: the sequencing and the failure handling are what is worth testing,
 * and neither needs a real image to be exercised.
 */
export async function generateMedia(
  input: GenerateMediaInput,
  db: Db = prisma,
  generate: ImageGenerator = generateImage,
): Promise<GenerateMediaResult> {
  const targets = visualDrafts(input.drafted);
  const outcomes: MediaGenerationOutcome[] = [];

  for (const draft of targets) {
    const prompt = toImagePrompt(draft, input.client);
    const form = draft.item.content_form as VisualForm;

    try {
      const image = await generate(prompt, {
        aspectRatio: ASPECT_FOR_FORM[form],
      });

      const stored = await storeMedia(
        draft.contentItemId,
        {
          bytes: image.bytes,
          mimeType: image.mimeType,
          assetType: ASSET_TYPE_FOR_FORM[form],
          generationSource: "ai_generated",
          // The prompt that actually produced the pixels, which is the model's
          // own rewrite where it returned one.
          prompt: image.enhancedPrompt ?? prompt,
          createdById: null,
        },
        db,
      );

      outcomes.push({
        status: "generated",
        contentItemId: draft.contentItemId,
        mediaAssetId: stored.media_asset_id,
        storageUrl: stored.storage_url,
        prompt,
      });
    } catch (error) {
      // A decline and a fault are both survivable and are told apart, because
      // the creator's next move differs: reword, or press the button again.
      const declined =
        error instanceof ImageGenerationError && error.filteredReason !== null;

      outcomes.push({
        status: declined ? "declined" : "failed",
        contentItemId: draft.contentItemId,
        prompt,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { attempted: targets.length, outcomes };
}
