import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

import { prisma } from "@/db";
import { SESSION_COOKIE } from "@/api/request";
import { createSession } from "@/domain/session";

/**
 * The HTTP shell over the conversation modules.
 *
 * The chat itself -- the on-task check, the fold, when the engine runs -- is
 * tested in `lib/engine/chatTurn.test.ts`. What is tested here is only what the
 * routes add: that the acting user comes from the session cookie, that a thread
 * for a client the caller cannot reach is refused, that someone else's thread is
 * a 403 rather than a 404, and that all three turn outcomes answer 200 with a
 * status the caller can branch on.
 *
 * `chatTurn` is mocked because the real one makes Gemini calls. That mock is the
 * only seam; the session, the permission check and the database are all real.
 */

let cookieJar: Record<string, string> = {};

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      cookieJar[name] === undefined ? undefined : { name, value: cookieJar[name] },
  }),
}));

const chatTurn = vi.fn();
vi.mock("@/engine/chatTurn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/engine/chatTurn")>();
  return { ...actual, chatTurn: (...args: unknown[]) => chatTurn(...args) };
});

const { GET: listConversationsRoute, POST: openConversationRoute } = await import(
  "@/app/api/conversations/route"
);
const { POST: postTurn } = await import("@/app/api/conversations/[id]/turns/route");
const { GET: getConversation } = await import("@/app/api/conversations/[id]/route");

/** A creator assigned to CL-101, and a client contact who is not staff. */
const CREATOR_EMAIL = "mona.farid@skipstudio.test";
const CONTACT_EMAIL = "rana.fouad@skipstudio.test";

const conversationIds: string[] = [];
const sessionUserIds: string[] = [];

async function signIn(email: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const { token } = await createSession({ userId: user.user_id });
  cookieJar[SESSION_COOKIE] = token;
  sessionUserIds.push(user.user_id);
  return user;
}

function post(body: unknown) {
  return new Request("http://test/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function openThread(clientId = "CL-101", title: string | null = null) {
  const response = await openConversationRoute(post({ client_id: clientId, title }));
  const json = await response.json();
  if (json.conversation_id) conversationIds.push(json.conversation_id);
  return { response, json };
}

beforeEach(() => {
  cookieJar = {};
  chatTurn.mockReset();
});

afterEach(async () => {
  await prisma.conversationTurn.deleteMany({
    where: { conversation_id: { in: conversationIds } },
  });
  await prisma.conversation.deleteMany({ where: { conversation_id: { in: conversationIds } } });
  conversationIds.length = 0;

  await prisma.session.deleteMany({ where: { user_id: { in: sessionUserIds } } });
  await prisma.flag.deleteMany({ where: { raised_against_id: { in: sessionUserIds } } });
  await prisma.auditLog.deleteMany({ where: { performed_by_id: { in: sessionUserIds } } });
  sessionUserIds.length = 0;
});

describe("POST /api/conversations", () => {
  it("opens a thread for a client the creator is assigned to", async () => {
    await signIn(CREATOR_EMAIL);

    const { response, json } = await openThread("CL-101", "Cold brew");

    expect(response.status).toBe(201);
    expect(json.client_id).toBe("CL-101");
    expect(json.campaign_id).toBeNull();
  });

  it("refuses a client the creator is not assigned to", async () => {
    await signIn(CREATOR_EMAIL);

    const { response } = await openThread("CL-108");

    expect(response.status).toBe(403);
  });

  it("refuses a client contact: the engine is a staff surface", async () => {
    await signIn(CONTACT_EMAIL);

    const { response } = await openThread("CL-101");

    expect(response.status).toBe(403);
  });

  it("refuses an unauthenticated caller", async () => {
    const response = await openConversationRoute(post({ client_id: "CL-101" }));
    expect(response.status).toBe(401);
  });
});

describe("GET /api/conversations", () => {
  it("lists only the caller's own threads", async () => {
    const creator = await signIn(CREATOR_EMAIL);
    await openThread("CL-101", "mine");

    // A thread belonging to someone else on the same client.
    const other = await prisma.user.findFirstOrThrow({
      where: { user_type: "staff", user_id: { not: creator.user_id } },
    });
    const theirs = await prisma.conversation.create({
      data: { client_id: "CL-101", created_by_id: other.user_id, title: "theirs" },
    });
    conversationIds.push(theirs.conversation_id);

    const response = await listConversationsRoute();
    const json = await response.json();

    expect(response.status).toBe(200);
    const titles = json.conversations.map((c: { title: string }) => c.title);
    expect(titles).toContain("mine");
    expect(titles).not.toContain("theirs");
  });
});

describe("POST /api/conversations/[id]/turns", () => {
  function turnRequest(prompt: string) {
    return new Request("http://test/api/conversations/x/turns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
  }

  it("answers 200 with the question when the thread does not yet say enough", async () => {
    await signIn(CREATOR_EMAIL);
    const { json: thread } = await openThread();

    chatTurn.mockResolvedValue({
      status: "asking",
      assistantMessage: "Who is it speaking to?",
      accumulated: {
        fields: { client: "Cairo Roast" },
        missing: ["audience", "channels"],
        complete: false,
      },
    });

    const response = await postTurn(turnRequest("a post for Cairo Roast"), {
      params: { id: thread.conversation_id },
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.status).toBe("asking");
    expect(json.assistant_message).toBe("Who is it speaking to?");
    expect(json.missing).toEqual(["audience", "channels"]);
  });

  it("answers 200 -- not 4xx -- when the turn is refused", async () => {
    await signIn(CREATOR_EMAIL);
    const { json: thread } = await openThread();

    chatTurn.mockResolvedValue({
      status: "refused",
      assistantMessage: "That is outside what this conversation is for.",
      verdict: { onTask: false, stage: "model", reason: "This is a personal document." },
    });

    const response = await postTurn(turnRequest("write my CV"), {
      params: { id: thread.conversation_id },
    });
    const json = await response.json();

    // The caller was permitted to send it, and their next message will work
    // fine. The refusal is the turn's answer, not a failed request.
    expect(response.status).toBe(200);
    expect(json.status).toBe("refused");
    expect(json.reason).toBe("This is a personal document.");
  });

  it("returns the intake summary when the thread produces work, without the trace", async () => {
    await signIn(CREATOR_EMAIL);
    const { json: thread } = await openThread();

    chatTurn.mockResolvedValue({
      status: "produced",
      assistantMessage: "Drafted 3 items.",
      accumulated: { fields: { client: "Cairo Roast" }, missing: [], complete: true },
      submitted: {
        campaign: { campaign_id: "camp-1", client_id: "CL-101", title: "t", status: "complete" },
        outcome: "DRAFT",
        clauseCode: null,
        reason: null,
        counts: { drafted: 3, flagged: 0, requestInfo: 0 },
        run: { enormous: "trace" },
      },
    });

    const response = await postTurn(turnRequest("students, on instagram"), {
      params: { id: thread.conversation_id },
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.status).toBe("produced");
    expect(json.counts.drafted).toBe(3);
    // The engine trace is large; a screen that needs it reads the persisted rows.
    expect(json.run).toBeUndefined();
  });

  it("refuses a turn on someone else's thread with 403, not 404", async () => {
    const creator = await signIn(CREATOR_EMAIL);

    const other = await prisma.user.findFirstOrThrow({
      where: { user_type: "staff", user_id: { not: creator.user_id } },
    });
    const theirs = await prisma.conversation.create({
      data: { client_id: "CL-101", created_by_id: other.user_id },
    });
    conversationIds.push(theirs.conversation_id);

    const { ConversationAccessError } = await import("@/domain/conversations");
    chatTurn.mockRejectedValue(
      new ConversationAccessError(theirs.conversation_id, creator.user_id),
    );

    const response = await postTurn(turnRequest("hello"), {
      params: { id: theirs.conversation_id },
    });

    // A 404 would let a creator enumerate colleagues' threads by id.
    expect(response.status).toBe(403);
  });
});

describe("GET /api/conversations/[id]", () => {
  it("returns the transcript oldest first", async () => {
    const creator = await signIn(CREATOR_EMAIL);
    const { json: thread } = await openThread();

    await prisma.conversationTurn.create({
      data: { conversation_id: thread.conversation_id, role: "creator", body: "first" },
    });
    await prisma.conversationTurn.create({
      data: { conversation_id: thread.conversation_id, role: "assistant", body: "second" },
    });

    const response = await getConversation(new Request("http://test"), {
      params: { id: thread.conversation_id },
    });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.turns.map((t: { body: string }) => t.body)).toEqual(["first", "second"]);
    expect(json.items).toEqual([]);
    void creator;
  });

  it("refuses another person's thread with 403", async () => {
    const creator = await signIn(CREATOR_EMAIL);

    const other = await prisma.user.findFirstOrThrow({
      where: { user_type: "staff", user_id: { not: creator.user_id } },
    });
    const theirs = await prisma.conversation.create({
      data: { client_id: "CL-101", created_by_id: other.user_id },
    });
    conversationIds.push(theirs.conversation_id);

    const response = await getConversation(new Request("http://test"), {
      params: { id: theirs.conversation_id },
    });

    expect(response.status).toBe(403);
  });

  it("404s a thread that does not exist", async () => {
    await signIn(CREATOR_EMAIL);

    const response = await getConversation(new Request("http://test"), {
      params: { id: "no-such-thread" },
    });

    expect(response.status).toBe(404);
  });
});
