import { describe, it, expect, beforeEach, afterAll } from "vitest";

import { prisma } from "../db";
import { openConversation } from "../domain/conversations";
import type { TurnExtraction } from "../domain/briefAccumulation";
import { chatTurn, type ChatTurnDependencies } from "./chatTurn";
import type { OnTaskJudge } from "./onTaskCheck";

/**
 * The chat path, end to end, with the model calls stubbed.
 *
 * Two properties carry this phase, and both are asserted here rather than
 * assumed:
 *
 *   - An incomplete thread never produces an item. It asks. That is Clause 0.5
 *     alive on this path, and it is the thing most likely to be eroded later by
 *     someone wanting the chat to feel more helpful.
 *   - A refused turn costs nothing further. No campaign, no items -- and the
 *     turn itself is kept, because a flag pointing at nothing is not evidence.
 */

const CREATOR = "TEST-CT-CREATOR";
const CLIENT = "CL-101";

const creator = { user_id: CREATOR, user_type: "staff", is_agency_admin: false, status: "active" };

/** Extraction is stubbed per turn body -- no network, and no guessing to test. */
function extractorFor(map: Record<string, TurnExtraction>): ChatTurnDependencies["extract"] {
  return async (turn: string) =>
    map[turn] ?? { client: null, objective: null, audience: null, channels: null };
}

const allowAll: OnTaskJudge = async () => ({ on_task: true, reason: "on task" });
const refuseAll: OnTaskJudge = async () => ({
  on_task: false,
  reason: "This is a request for a personal document, not client content.",
});

async function cleanup() {
  const conversations = await prisma.conversation.findMany({
    where: { created_by_id: CREATOR },
    select: { conversation_id: true, campaign_id: true },
  });
  const campaignIds = conversations
    .map((c) => c.campaign_id)
    .filter((id): id is string => Boolean(id));

  await prisma.conversationTurn.deleteMany({
    where: { conversation: { created_by_id: CREATOR } },
  });
  await prisma.conversation.deleteMany({ where: { created_by_id: CREATOR } });
  if (campaignIds.length > 0) {
    await prisma.contentItem.deleteMany({ where: { campaign_id: { in: campaignIds } } });
    await prisma.campaign.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  }
  await prisma.campaign.deleteMany({ where: { submitted_by_id: CREATOR } });
  await prisma.flag.deleteMany({ where: { raised_against_id: CREATOR } });
  await prisma.auditLog.deleteMany({ where: { performed_by_id: CREATOR } });
  await prisma.clientAssignment.deleteMany({ where: { user_id: CREATOR } });
}

beforeEach(async () => {
  await cleanup();
  await prisma.user.upsert({
    where: { user_id: CREATOR },
    update: { status: "active", user_type: "staff" },
    create: {
      user_id: CREATOR,
      name: "Test Chat Creator",
      email: "test-ct-creator@skipstudio.test",
      user_type: "staff",
    },
  });
  await prisma.clientAssignment.create({
    data: { client_id: CLIENT, user_id: CREATOR, role_on_client: "content_creator" },
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { user_id: CREATOR } });
});

describe("an incomplete thread", () => {
  it("asks for the missing field instead of producing anything", async () => {
    const conversation = await openConversation(creator, CLIENT, null);

    const result = await chatTurn(
      creator,
      conversation.conversationId,
      "something for the cold brew launch",
      prisma,
      {
        extract: extractorFor({
          "something for the cold brew launch": {
            client: "Cairo Roast",
            objective: "launch the cold brew",
            audience: null,
            channels: null,
          },
        }),
        onTaskJudge: allowAll,
      },
    );

    expect(result.status).toBe("asking");
    if (result.status !== "asking") return;
    expect(result.assistantMessage).toBe("Who is it speaking to?");
    expect(result.accumulated.missing).toEqual(["audience", "channels"]);

    // Nothing was produced. This is the assertion that keeps Clause 0.5 real.
    const campaigns = await prisma.campaign.count({ where: { submitted_by_id: CREATOR } });
    expect(campaigns).toBe(0);

    const reloaded = await prisma.conversation.findUniqueOrThrow({
      where: { conversation_id: conversation.conversationId },
    });
    expect(reloaded.campaign_id).toBeNull();
  });

  it("stores both the creator's turn and the question it was asked", async () => {
    const conversation = await openConversation(creator, CLIENT, null);

    await chatTurn(creator, conversation.conversationId, "a post for Cairo Roast", prisma, {
      extract: extractorFor({
        "a post for Cairo Roast": {
          client: "Cairo Roast",
          objective: null,
          audience: null,
          channels: null,
        },
      }),
      onTaskJudge: allowAll,
    });

    const turns = await prisma.conversationTurn.findMany({
      where: { conversation_id: conversation.conversationId },
      orderBy: { created_at: "asc" },
    });
    expect(turns.map((t) => t.role)).toEqual(["creator", "assistant"]);
  });
});

describe("a refused turn", () => {
  it("costs nothing further, and is kept as evidence", async () => {
    const conversation = await openConversation(creator, CLIENT, null);

    const result = await chatTurn(
      creator,
      conversation.conversationId,
      "write my CV please",
      prisma,
      { extract: extractorFor({}), onTaskJudge: refuseAll },
    );

    expect(result.status).toBe("refused");

    // No campaign, no items.
    expect(await prisma.campaign.count({ where: { submitted_by_id: CREATOR } })).toBe(0);

    // The flag exists, names the person, and carries the thread.
    const [flag] = await prisma.flag.findMany({
      where: { raised_against_id: CREATOR, flag_type: "off_task_generation" },
    });
    expect(flag).toBeDefined();
    const details = JSON.parse(flag.details ?? "{}");
    expect(details.conversation_id).toBe(conversation.conversationId);

    // And the refused turn points back at the flag, so the Admin's queue row
    // opens the thread around it rather than showing a bare excerpt.
    const turn = await prisma.conversationTurn.findFirstOrThrow({
      where: { conversation_id: conversation.conversationId, role: "creator" },
    });
    expect(turn.flag_id).toBe(flag.flag_id);
    expect(turn.body).toBe("write my CV please");
  });

  it("refuses at turn nine as readily as at turn one", async () => {
    const conversation = await openConversation(creator, CLIENT, null);

    for (let i = 0; i < 4; i += 1) {
      await chatTurn(creator, conversation.conversationId, `caption idea ${i}`, prisma, {
        extract: extractorFor({}),
        onTaskJudge: allowAll,
      });
    }

    const result = await chatTurn(
      creator,
      conversation.conversationId,
      "now explain quantum physics",
      prisma,
      { extract: extractorFor({}), onTaskJudge: refuseAll },
    );

    // A thread of on-task turns does not buy an off-task one.
    expect(result.status).toBe("refused");
  });
});

describe("access", () => {
  it("refuses a turn on someone else's thread", async () => {
    const conversation = await openConversation(creator, CLIENT, null);

    const stranger = {
      user_id: "TEST-CT-STRANGER",
      user_type: "staff",
      is_agency_admin: false,
      status: "active",
    };

    await expect(
      chatTurn(stranger, conversation.conversationId, "hello", prisma, {
        extract: extractorFor({}),
        onTaskJudge: allowAll,
      }),
    ).rejects.toMatchObject({ name: "ConversationAccessError" });
  });
});
