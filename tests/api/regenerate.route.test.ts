import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";

import { prisma } from "@/db";
import { SESSION_COOKIE } from "@/api/request";
import { createSession } from "@/domain/session";
import { OffTaskPromptError } from "@/engine/regenerateItem";

/**
 * The HTTP shell over `regenerateItem`.
 *
 * The regeneration itself -- grounding, the on-task refusal, the approval reset
 * -- is tested in `lib/engine/regenerateItem.test.ts`. What is tested here is
 * only what the route adds: that the acting user comes from the session cookie,
 * that `content.attach_reference` is checked separately from
 * `content.regenerate` and only when files are present, that a multipart body
 * becomes `ReferenceAttachment` rows on disk and in the database, and that a
 * refusal is the right status rather than a 500.
 *
 * `regenerateItem` is mocked because the real one makes Gemini calls. That mock
 * is the only seam; the permission check, the reference persistence and the
 * database underneath them are all real.
 */

let cookieJar: Record<string, string> = {};

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      cookieJar[name] === undefined ? undefined : { name, value: cookieJar[name] },
  }),
}));

const regenerateItem = vi.fn();
vi.mock("@/engine/regenerateItem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/engine/regenerateItem")>();
  return { ...actual, regenerateItem: (...args: unknown[]) => regenerateItem(...args) };
});

// Imported after the mocks are registered, so the route picks them up.
const { POST } = await import("@/app/api/content-items/[id]/regenerate/route");

/** A creator assigned to CL-101, and a client contact who is not staff. */
const CREATOR_EMAIL = "mona.farid@skipstudio.test";
const CONTACT_EMAIL = "rana.fouad@skipstudio.test";

const campaignIds: string[] = [];
const itemIds: string[] = [];
const sessionUserIds: string[] = [];

async function signIn(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const { token } = await createSession({ userId: user.user_id });
  cookieJar[SESSION_COOKIE] = token;
  sessionUserIds.push(user.user_id);
  return user;
}

/** An item on CL-101, which the creator above is assigned to. */
async function createItem() {
  const campaign = await prisma.campaign.create({
    data: {
      client_id: "CL-101",
      title: "P4.3 route test",
      objective: "test regeneration over HTTP",
      audience: "test",
      channels: JSON.stringify(["Instagram"]),
      raw_brief_text: "P4.3 test brief",
    },
  });
  campaignIds.push(campaign.campaign_id);

  const item = await prisma.contentItem.create({
    data: {
      campaign_id: campaign.campaign_id,
      content_form: "post",
      platform: "instagram",
      content_body: "Original copy.",
      status: "drafted",
    },
  });
  itemIds.push(item.content_item_id);
  return item;
}

function request(id: string, form: FormData) {
  return new Request(`http://localhost/api/content-items/${id}/regenerate`, {
    method: "POST",
    body: form,
  });
}

/** The route's happy-path return shape, so the mock stands in convincingly. */
function regenerationResult(contentItemId: string, references: unknown[] = []) {
  return {
    contentItemId,
    item: { content_body: "Regenerated copy.", clause_codes: ["0.1"] },
    compliance: { outcome: { decision: "DRAFT" } },
    status: "drafted",
    referenceIds: (references as { attachment_id: string }[]).map((r) => r.attachment_id),
  };
}

beforeEach(() => {
  regenerateItem.mockReset();
});

afterEach(async () => {
  cookieJar = {};

  // Files first -- the rows carry the paths that need removing.
  const attachments = await prisma.referenceAttachment.findMany({
    where: { content_item_id: { in: itemIds } },
    select: { storage_url: true },
  });
  await Promise.all(attachments.map((a) => rm(a.storage_url, { force: true })));

  await prisma.auditLog.deleteMany({ where: { entity_type: "ReferenceAttachment" } });
  await prisma.auditLog.deleteMany({ where: { entity_type: "Flag" } });
  await prisma.flag.deleteMany({});
  await prisma.referenceAttachment.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.contentItem.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.campaign.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  while (sessionUserIds.length > 0) {
    await prisma.session.deleteMany({ where: { user_id: sessionUserIds.pop()! } });
  }
  itemIds.length = 0;
  campaignIds.length = 0;
});

describe("POST /api/content-items/[id]/regenerate", () => {
  it("refuses an unauthenticated request with 401", async () => {
    const item = await createItem();
    const form = new FormData();
    form.set("prompt", "Make the hook quieter.");

    const response = await POST(request(item.content_item_id, form), {
      params: { id: item.content_item_id },
    });

    expect(response.status).toBe(401);
    expect(regenerateItem).not.toHaveBeenCalled();
  });

  it("regenerates from a prompt alone, with no attachments", async () => {
    const item = await createItem();
    await signIn(CREATOR_EMAIL);
    regenerateItem.mockResolvedValue(regenerationResult(item.content_item_id));

    const form = new FormData();
    form.set("prompt", "Make the hook quieter.");

    const response = await POST(request(item.content_item_id, form), {
      params: { id: item.content_item_id },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.decision).toBe("DRAFT");

    // No files means no `references` key at all -- so the engine falls back to
    // whatever is already on file rather than being told there are none.
    const [, input] = regenerateItem.mock.calls[0];
    expect(input).not.toHaveProperty("references");
    expect(input.prompt).toBe("Make the hook quieter.");
  });

  it("writes a ReferenceAttachment row and a file for an attached image", async () => {
    const item = await createItem();
    const creator = await signIn(CREATOR_EMAIL);
    regenerateItem.mockImplementation(async (id: string, input: { references?: unknown[] }) =>
      regenerationResult(id, input.references ?? []),
    );

    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const form = new FormData();
    form.set("prompt", "Match this angle.");
    form.append("files", new File([bytes], "ref.png", { type: "image/png" }));
    form.append("instructions", "Match this angle");

    const response = await POST(request(item.content_item_id, form), {
      params: { id: item.content_item_id },
    });

    expect(response.status).toBe(200);

    const rows = await prisma.referenceAttachment.findMany({
      where: { content_item_id: item.content_item_id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].file_type).toBe("image");
    expect(rows[0].instruction).toBe("Match this angle");
    expect(rows[0].uploaded_by_id).toBe(creator.user_id);

    // The bytes actually reached disk -- `regenerateItem` reads this path.
    expect(await readFile(rows[0].storage_url)).toEqual(bytes);

    // And the row was handed to the engine, not merely stored.
    const [, input] = regenerateItem.mock.calls[0];
    expect(input.references).toHaveLength(1);
  });

  it("refuses a video reference with 422 and stores nothing", async () => {
    const item = await createItem();
    await signIn(CREATOR_EMAIL);

    const form = new FormData();
    form.set("prompt", "Match this pacing.");
    form.append("files", new File([Buffer.from([0, 1, 2])], "clip.mp4", { type: "video/mp4" }));

    const response = await POST(request(item.content_item_id, form), {
      params: { id: item.content_item_id },
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(Object.keys(body.error.issues)).toContain("files.0");
    expect(
      await prisma.referenceAttachment.count({ where: { content_item_id: item.content_item_id } }),
    ).toBe(0);
    expect(regenerateItem).not.toHaveBeenCalled();
  });

  it("refuses a client contact with 403 and never reaches the engine", async () => {
    const item = await createItem();
    const contact = await signIn(CONTACT_EMAIL);

    const form = new FormData();
    form.set("prompt", "Rewrite this for me.");

    const response = await POST(request(item.content_item_id, form), {
      params: { id: item.content_item_id },
    });

    expect(response.status).toBe(403);
    expect(regenerateItem).not.toHaveBeenCalled();

    // The refusal is recorded for the Admin, not swallowed.
    const flags = await prisma.flag.findMany({
      where: { flag_type: "role_boundary_violation", raised_against_id: contact.user_id },
    });
    expect(flags.length).toBeGreaterThan(0);
  });

  it("answers 422 for an empty prompt without spending a model call", async () => {
    const item = await createItem();
    await signIn(CREATOR_EMAIL);

    const form = new FormData();
    form.set("prompt", "   ");

    const response = await POST(request(item.content_item_id, form), {
      params: { id: item.content_item_id },
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.issues.prompt).toBeDefined();
    expect(regenerateItem).not.toHaveBeenCalled();
  });

  it("answers 422, not 403, when the engine refuses an off-task prompt", async () => {
    const item = await createItem();
    await signIn(CREATOR_EMAIL);
    regenerateItem.mockRejectedValue(
      // `stage: "model"` because only the model's own judgement ever refuses --
      // the deterministic pass in `onTaskCheck` allows and never blocks.
      new OffTaskPromptError({
        onTask: false,
        stage: "model",
        reason: "This is a CV, not client content.",
      }),
    );

    const form = new FormData();
    form.set("prompt", "Write my CV.");

    const response = await POST(request(item.content_item_id, form), {
      params: { id: item.content_item_id },
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("OFF_TASK_PROMPT");
  });

  it("denies by scope on an unknown item rather than leaking that it is unknown", async () => {
    await signIn(CREATOR_EMAIL);

    const form = new FormData();
    form.set("prompt", "Make the hook quieter.");

    const response = await POST(request("no-such-item", form), { params: { id: "no-such-item" } });

    expect(response.status).toBe(403);
    expect(regenerateItem).not.toHaveBeenCalled();
  });
});
