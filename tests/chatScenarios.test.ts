import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

import { prisma } from "@/db";
import { canSchedule } from "@/domain/gate";
import { openConversation } from "@/domain/conversations";
import { assignItem } from "@/domain/taskAssignment";
import { chatTurn, type ChatTurnDependencies } from "@/engine/chatTurn";
import type { OnTaskJudge } from "@/engine/onTaskCheck";
import type { TurnExtraction } from "@/domain/briefAccumulation";

/**
 * Phase 14's scenarios, for `P12.2`.
 *
 * These are not unit tests of the modules involved -- each of those has its own
 * file. They exist to assert the properties the *phase* claims, across whatever
 * layers it takes to reach them, so that a future change which quietly breaks
 * one fails here with the claim named rather than somewhere deep in a helper.
 *
 * The claim under all of them: **the conversation is a surface, never a second
 * route to production.** Every guarantee the brief path makes, this path makes,
 * because it reaches them through the same code.
 *
 * The model calls are stubbed. The database, the permission matrix, the gate and
 * the status machine are all real -- stubbing those would be stubbing the thing
 * being tested.
 */

const CREATOR = "TEST-SC-CREATOR";
const OTHER_CREATOR = "TEST-SC-CREATOR-B";
const LEAD = "TEST-SC-LEAD";
const USERS = [CREATOR, OTHER_CREATOR, LEAD];

/** CL-101 is active and seeded; CL-109 is the seeded inactive client. */
const ASSIGNED_CLIENT = "CL-101";
const UNASSIGNED_CLIENT = "CL-108";
const INACTIVE_CLIENT = "CL-109";

const creator = { user_id: CREATOR, user_type: "staff", is_agency_admin: false, status: "active" };
const otherCreator = {
  user_id: OTHER_CREATOR,
  user_type: "staff",
  is_agency_admin: false,
  status: "active",
};
const lead = { user_id: LEAD, user_type: "staff", is_agency_admin: false, status: "active" };

const allowAll: OnTaskJudge = async () => ({ on_task: true, reason: "on task" });
const refuseAll: OnTaskJudge = async () => ({
  on_task: false,
  reason: "This is a personal document, not client content.",
});

/** A complete brief in one turn, so a scenario reaches generation immediately. */
const COMPLETE = "everything, in one go";
const completeExtraction: TurnExtraction = {
  client: "Cairo Roast",
  objective: "launch the cold brew",
  audience: "office workers in Cairo",
  channels: "instagram",
};

function deps(
  map: Record<string, TurnExtraction>,
  judge: OnTaskJudge = allowAll,
): ChatTurnDependencies {
  return {
    extract: async (turn: string) =>
      map[turn] ?? { client: null, objective: null, audience: null, channels: null },
    onTaskJudge: judge,
  };
}

/**
 * The engine, stubbed at its three model calls.
 *
 * `submitBrief` runs for real -- and with it `runIntake`, client resolution, the
 * completeness check, override detection, retrieval, `queueOrFlag` and every
 * persistence step. Only what would reach Gemini is replaced, which is what lets
 * these scenarios assert the guards rather than the network.
 */
vi.mock("@/engine/analyzeBrief", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/engine/analyzeBrief")>();
  return {
    ...actual,
    analyzeBrief: async (briefText: string) => {
      const field = (label: string) =>
        new RegExp(`^${label}: (.*)$`, "m").exec(briefText)?.[1]?.trim() || null;

      // `toBriefText` writes "Name (CL-nnn)", so both halves are read out --
      // mirroring the real extractor, which reports a literal CL-nnn code as
      // `client_id` and anything else as `client_reference`.
      const written = field("Client");
      const code = /\((CL-\d+)\)/.exec(written ?? "")?.[1] ?? null;
      const name = (written ?? "").replace(/\s*\(CL-\d+\)\s*/, "").trim() || null;

      return {
        client_reference: name,
        client_id: code ?? clientIdForName(name),
        title: field("Objective"),
        objective: field("Objective"),
        audience: field("Audience"),
        channels: field("Channels") ? [field("Channels") as string] : [],
        deliverables: [{ kind: "post", quantity: 1, raw: "post" }],
        notes: briefText,
        date: null,
        explicitly_missing: [],
      };
    },
  };
});

vi.mock("@/engine/generatePlan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/engine/generatePlan")>();
  return {
    ...actual,
    generatePlan: async () => ({
      items: [
        {
          content_form: "post",
          platform: "instagram",
          content_body: "Cold brew season is here.",
          market_id: null,
          scheduled_date: null,
          clause_codes: ["0.1"],
        },
      ],
      notes: null,
    }),
  };
});

vi.mock("@/engine/complianceCheck", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/engine/complianceCheck")>();
  return {
    ...actual,
    judgeWithGemini: async () => ({ decision: "DRAFT", clause_codes: ["0.1"], reason: "Clean." }),
  };
});

/** The seeded names, resolved once. Filled in `beforeEach`. */
let nameToId = new Map<string, string>();
function clientIdForName(name: string | null): string | null {
  if (!name) return null;
  return nameToId.get(name.toLowerCase()) ?? null;
}

async function cleanup() {
  const conversations = await prisma.conversation.findMany({
    where: { created_by_id: { in: USERS } },
    select: { conversation_id: true, campaign_id: true },
  });
  const campaignIds = conversations
    .map((c) => c.campaign_id)
    .filter((id): id is string => Boolean(id));

  await prisma.conversationTurn.deleteMany({
    where: { conversation: { created_by_id: { in: USERS } } },
  });
  await prisma.conversation.deleteMany({ where: { created_by_id: { in: USERS } } });

  const campaigns = await prisma.campaign.findMany({
    where: { OR: [{ campaign_id: { in: campaignIds } }, { submitted_by_id: { in: USERS } }] },
    select: { campaign_id: true },
  });
  const allCampaignIds = campaigns.map((c) => c.campaign_id);

  if (allCampaignIds.length > 0) {
    const items = await prisma.contentItem.findMany({
      where: { campaign_id: { in: allCampaignIds } },
      select: { content_item_id: true },
    });
    const itemIds = items.map((i) => i.content_item_id);
    await prisma.approval.deleteMany({ where: { content_item_id: { in: itemIds } } });
    await prisma.contentItemCitation.deleteMany({
      where: { content_item_id: { in: itemIds } },
    });
    await prisma.contentItem.deleteMany({ where: { campaign_id: { in: allCampaignIds } } });
    await prisma.flag.deleteMany({ where: { campaign_id: { in: allCampaignIds } } });
    await prisma.campaign.deleteMany({ where: { campaign_id: { in: allCampaignIds } } });
  }

  await prisma.flag.deleteMany({ where: { raised_against_id: { in: USERS } } });
  await prisma.auditLog.deleteMany({ where: { performed_by_id: { in: USERS } } });
  await prisma.clientAssignment.deleteMany({ where: { user_id: { in: USERS } } });
}

beforeEach(async () => {
  await cleanup();

  for (const id of USERS) {
    await prisma.user.upsert({
      where: { user_id: id },
      update: { status: "active", user_type: "staff", is_agency_admin: false },
      create: {
        user_id: id,
        name: id,
        email: `${id.toLowerCase()}@skipstudio.test`,
        user_type: "staff",
      },
    });
  }

  await prisma.clientAssignment.createMany({
    data: [
      { client_id: ASSIGNED_CLIENT, user_id: CREATOR, role_on_client: "content_creator" },
      { client_id: ASSIGNED_CLIENT, user_id: OTHER_CREATOR, role_on_client: "content_creator" },
      { client_id: ASSIGNED_CLIENT, user_id: LEAD, role_on_client: "content_lead" },
    ],
  });

  const clients = await prisma.client.findMany({ select: { client_id: true, name: true } });
  nameToId = new Map(clients.map((c) => [c.name.toLowerCase(), c.client_id]));
});

afterAll(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { user_id: { in: USERS } } });
});

describe("Clause 0.5 on the chat path", () => {
  it("never produces an item from an incomplete thread -- it asks", async () => {
    const conversation = await openConversation(creator, ASSIGNED_CLIENT, null);

    // Three of the four fields. The brief path would return REQUEST_INFO here;
    // the chat path asks for the fourth instead. Neither guesses.
    const result = await chatTurn(
      creator,
      conversation.conversationId,
      "a launch post",
      prisma,
      deps({
        "a launch post": {
          client: "Cairo Roast",
          objective: "launch the cold brew",
          audience: "office workers",
          channels: null,
        },
      }),
    );

    expect(result.status).toBe("asking");
    if (result.status === "asking") {
      expect(result.accumulated.missing).toEqual(["channels"]);
    }

    // The assertion that matters: nothing was produced.
    const items = await prisma.contentItem.count({
      where: { campaign: { submitted_by_id: CREATOR } },
    });
    expect(items).toBe(0);
  });
});

describe("Clause 0.6 on the chat path", () => {
  it("flags an inactive client exactly as a brief does", async () => {
    // The lead can open a thread for any client, including an inactive one --
    // the refusal belongs to the engine, not to the door.
    const conversation = await openConversation(lead, INACTIVE_CLIENT, null);

    const result = await chatTurn(
      lead,
      conversation.conversationId,
      COMPLETE,
      prisma,
      deps({ [COMPLETE]: completeExtraction }),
    );

    expect(result.status).toBe("produced");
    if (result.status !== "produced") return;

    // Clause 0.6, cited by `resolveClient` inside the pipeline the chat calls.
    expect(result.submitted.outcome).toBe("FLAG");
    expect(result.submitted.clauseCode).toBe("0.6");
  });
});

describe("the gate, on items produced in a conversation", () => {
  it("refuses to schedule one with no approvals recorded", async () => {
    const conversation = await openConversation(creator, ASSIGNED_CLIENT, null);

    const result = await chatTurn(
      creator,
      conversation.conversationId,
      COMPLETE,
      prisma,
      deps({ [COMPLETE]: completeExtraction }),
    );

    expect(result.status).toBe("produced");
    if (result.status !== "produced") return;

    const item = await prisma.contentItem.findFirstOrThrow({
      where: { campaign_id: result.submitted.campaign.campaign_id },
    });

    const gate = await canSchedule(item.content_item_id);

    // Absence is not approval. An item born in a conversation is as blocked as
    // one born from a brief.
    expect(gate.allowed).toBe(false);
    expect(gate.blockedBy).toEqual(["internal", "client"]);
  });

  it("still requires both stages after a lead assigns it to a creator", async () => {
    const conversation = await openConversation(lead, ASSIGNED_CLIENT, null);

    const result = await chatTurn(
      lead,
      conversation.conversationId,
      COMPLETE,
      prisma,
      deps({ [COMPLETE]: completeExtraction }),
    );
    expect(result.status).toBe("produced");
    if (result.status !== "produced") return;

    const item = await prisma.contentItem.findFirstOrThrow({
      where: { campaign_id: result.submitted.campaign.campaign_id },
    });

    await assignItem(lead, item.content_item_id, CREATOR);

    // Dispatch is not approval. Handing work to someone does not advance it.
    const gate = await canSchedule(item.content_item_id);
    expect(gate.allowed).toBe(false);
    expect(gate.blockedBy).toEqual(["internal", "client"]);

    // Internal alone is still not enough.
    await prisma.approval.create({
      data: {
        content_item_id: item.content_item_id,
        stage: "internal",
        decision: "approve",
        decided_by_id: LEAD,
      },
    });

    const halfway = await canSchedule(item.content_item_id);
    expect(halfway.allowed).toBe(false);
    expect(halfway.blockedBy).toEqual(["client"]);
  });
});

describe("a thread stays with its client", () => {
  it("files against the conversation's client even when a turn names another", async () => {
    const conversation = await openConversation(creator, ASSIGNED_CLIENT, null);

    // The creator tries to switch client mid-thread. The campaign row is filed
    // against the thread's client, so the brief must name that one too --
    // otherwise `resolveClient` and the row disagree and `queueOrFlag` refuses
    // outright, surfacing as a crash rather than as a cross-client refusal.
    const result = await chatTurn(
      creator,
      conversation.conversationId,
      "actually make this for NileFit",
      prisma,
      deps({
        "actually make this for NileFit": {
          client: "NileFit",
          objective: "launch",
          audience: "students",
          channels: "instagram",
        },
      }),
    );

    expect(result.status).toBe("produced");
    if (result.status !== "produced") return;

    expect(result.submitted.campaign.client_id).toBe(ASSIGNED_CLIENT);
  });
});

describe("who may open a conversation", () => {
  it("refuses a creator a client they are not assigned to", async () => {
    await expect(openConversation(creator, UNASSIGNED_CLIENT, null)).rejects.toMatchObject({
      name: "PermissionDeniedError",
      action: "content.chat",
    });
  });

  it("lets a content lead open one for any client", async () => {
    // The lead holds no ClientAssignment on CL-108, and does not need one:
    // `effectiveRole` resolves them cross-client.
    const conversation = await openConversation(lead, UNASSIGNED_CLIENT, null);
    expect(conversation.clientId).toBe(UNASSIGNED_CLIENT);
  });
});

describe("an off-task turn", () => {
  it("is refused, flagged, linked to its turn, and costs no generation", async () => {
    const conversation = await openConversation(creator, ASSIGNED_CLIENT, null);

    const result = await chatTurn(
      creator,
      conversation.conversationId,
      "write my CV",
      prisma,
      deps({}, refuseAll),
    );

    expect(result.status).toBe("refused");

    // Nothing generated, nothing persisted beyond the evidence.
    expect(await prisma.campaign.count({ where: { submitted_by_id: CREATOR } })).toBe(0);

    const flag = await prisma.flag.findFirstOrThrow({
      where: { raised_against_id: CREATOR, flag_type: "off_task_generation" },
    });
    const details = JSON.parse(flag.details ?? "{}");
    expect(details.conversation_id).toBe(conversation.conversationId);

    // The turn points back at the flag, which is what lets the Admin open the
    // thread around it rather than reading a 500-character excerpt.
    const turn = await prisma.conversationTurn.findFirstOrThrow({
      where: { conversation_id: conversation.conversationId, role: "creator" },
    });
    expect(turn.flag_id).toBe(flag.flag_id);
  });
});

describe("who may dispatch, and to whom", () => {
  it("refuses a creator, and accepts only a creator on that client", async () => {
    const conversation = await openConversation(lead, ASSIGNED_CLIENT, null);
    const result = await chatTurn(
      lead,
      conversation.conversationId,
      COMPLETE,
      prisma,
      deps({ [COMPLETE]: completeExtraction }),
    );
    expect(result.status).toBe("produced");
    if (result.status !== "produced") return;

    const item = await prisma.contentItem.findFirstOrThrow({
      where: { campaign_id: result.submitted.campaign.campaign_id },
    });

    // A creator cannot hand their own work to a colleague.
    await expect(
      assignItem(creator, item.content_item_id, OTHER_CREATOR),
    ).rejects.toMatchObject({ name: "PermissionDeniedError" });

    // Nor may the lead hand it to someone holding no creator role there.
    await expect(assignItem(lead, item.content_item_id, LEAD)).rejects.toMatchObject({
      name: "TaskAssignmentError",
    });

    // A creator on this client is accepted.
    const assigned = await assignItem(lead, item.content_item_id, OTHER_CREATOR);
    expect(assigned.assigneeId).toBe(OTHER_CREATOR);
  });
});
