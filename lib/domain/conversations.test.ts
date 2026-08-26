import { describe, it, expect, beforeEach, afterAll } from "vitest";

import { prisma } from "../db";
import {
  ConversationAccessError,
  appendTurn,
  listConversations,
  loadConversation,
  openConversation,
} from "./conversations";

/**
 * Who reaches a thread.
 *
 * The property that matters most here is the stricter of the two checks: a
 * creator assigned to a client may chat for that client, but that does not let
 * them read a colleague's transcript for the same client. The Admin's conduct
 * review depends on a transcript being one person's record.
 */

const CREATOR = "TEST-CV-CREATOR";
const OTHER_CREATOR = "TEST-CV-CREATOR-B";
const LEAD = "TEST-CV-LEAD";
const ADMIN = "TEST-CV-ADMIN";
const USERS = [CREATOR, OTHER_CREATOR, LEAD, ADMIN];

const CLIENT_A = "CL-101";
const CLIENT_B = "CL-102";

const creator = { user_id: CREATOR, user_type: "staff", is_agency_admin: false, status: "active" };
const otherCreator = {
  user_id: OTHER_CREATOR,
  user_type: "staff",
  is_agency_admin: false,
  status: "active",
};
const lead = { user_id: LEAD, user_type: "staff", is_agency_admin: false, status: "active" };
const admin = { user_id: ADMIN, user_type: "staff", is_agency_admin: true, status: "active" };

async function cleanup() {
  await prisma.conversationTurn.deleteMany({
    where: { conversation: { created_by_id: { in: USERS } } },
  });
  await prisma.conversation.deleteMany({ where: { created_by_id: { in: USERS } } });
  await prisma.auditLog.deleteMany({ where: { performed_by_id: { in: USERS } } });
  await prisma.flag.deleteMany({ where: { raised_against_id: { in: USERS } } });
  await prisma.clientAssignment.deleteMany({ where: { user_id: { in: USERS } } });
}

beforeEach(async () => {
  await cleanup();

  for (const id of USERS) {
    await prisma.user.upsert({
      where: { user_id: id },
      update: { status: "active", user_type: "staff", is_agency_admin: id === ADMIN },
      create: {
        user_id: id,
        name: id,
        email: `${id.toLowerCase()}@skipstudio.test`,
        user_type: "staff",
        is_agency_admin: id === ADMIN,
      },
    });
  }

  await prisma.clientAssignment.createMany({
    data: [
      { client_id: CLIENT_A, user_id: CREATOR, role_on_client: "content_creator" },
      { client_id: CLIENT_A, user_id: OTHER_CREATOR, role_on_client: "content_creator" },
      { client_id: CLIENT_A, user_id: LEAD, role_on_client: "content_lead" },
    ],
  });
});

afterAll(async () => {
  await cleanup();
  await prisma.user.deleteMany({ where: { user_id: { in: USERS } } });
});

describe("opening a thread", () => {
  it("opens one for a client the creator is assigned to", async () => {
    const conversation = await openConversation(creator, CLIENT_A, "Cold brew launch");

    expect(conversation.clientId).toBe(CLIENT_A);
    expect(conversation.campaignId).toBeNull();

    const [audit] = await prisma.auditLog.findMany({
      where: { entity_id: conversation.conversationId, action: "created" },
    });
    expect(audit).toBeDefined();
  });

  it("refuses a client the creator is not assigned to", async () => {
    await expect(openConversation(creator, CLIENT_B, null)).rejects.toMatchObject({
      name: "PermissionDeniedError",
      action: "content.chat",
    });
  });

  it("lets a lead open one for any client -- the role is cross-client", async () => {
    const conversation = await openConversation(lead, CLIENT_B, null);
    expect(conversation.clientId).toBe(CLIENT_B);
  });

  it("refuses the agency admin: oversight is not content work", async () => {
    await expect(openConversation(admin, CLIENT_A, null)).rejects.toMatchObject({
      name: "PermissionDeniedError",
      reason: "role_lacks_capability",
    });
  });
});

describe("reading a thread", () => {
  it("refuses another creator on the same client", async () => {
    const conversation = await openConversation(creator, CLIENT_A, null);

    // Both are creators on CLIENT_A, so both may chat for it. A transcript is
    // still one person's record.
    await expect(
      loadConversation(otherCreator, conversation.conversationId),
    ).rejects.toThrow(ConversationAccessError);
  });

  it("lets the agency admin read any thread, for conduct review", async () => {
    const conversation = await openConversation(creator, CLIENT_A, null);
    await appendTurn(creator, conversation.conversationId, "creator", "something playful");

    const loaded = await loadConversation(admin, conversation.conversationId);
    expect(loaded.turns).toHaveLength(1);
  });

  it("returns turns oldest first", async () => {
    const conversation = await openConversation(creator, CLIENT_A, null);
    await appendTurn(creator, conversation.conversationId, "creator", "first");
    await appendTurn(creator, conversation.conversationId, "assistant", "second");
    await appendTurn(creator, conversation.conversationId, "creator", "third");

    const loaded = await loadConversation(creator, conversation.conversationId);
    expect(loaded.turns.map((t) => t.body)).toEqual(["first", "second", "third"]);
  });

  it("lists only the caller's own threads", async () => {
    await openConversation(creator, CLIENT_A, "mine");
    await openConversation(otherCreator, CLIENT_A, "theirs");

    const mine = await listConversations(creator);
    expect(mine).toHaveLength(1);
    expect(mine[0].title).toBe("mine");
  });
});

describe("appending", () => {
  it("refuses someone who does not own the thread", async () => {
    const conversation = await openConversation(creator, CLIENT_A, null);

    await expect(
      appendTurn(otherCreator, conversation.conversationId, "creator", "hello"),
    ).rejects.toThrow(ConversationAccessError);
  });

  it("re-checks capability on every append, not just at opening", async () => {
    const conversation = await openConversation(creator, CLIENT_A, null);

    // The assignment that granted `content.chat` is revoked mid-thread.
    await prisma.clientAssignment.deleteMany({
      where: { user_id: CREATOR, client_id: CLIENT_A },
    });

    await expect(
      appendTurn(creator, conversation.conversationId, "creator", "still there?"),
    ).rejects.toMatchObject({ name: "PermissionDeniedError" });
  });
});
