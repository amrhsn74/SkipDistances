import { readFileSync } from "node:fs";
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (!m) continue;
  if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

import { prisma } from "../lib/db";
import { chatTurn } from "../lib/engine/chatTurn";

const CONVO = "cmta06snk0001ggrd6p1xjoyi";

async function main() {
  const convo = await prisma.conversation.findUnique({
    where: { conversation_id: CONVO },
    select: {
      conversation_id: true, client_id: true, created_by_id: true, campaign_id: true,
      turns: { orderBy: { created_at: "asc" }, select: { role: true, body: true } },
    },
  });
  if (!convo) { console.log("no such conversation"); return; }

  console.log("client:", convo.client_id, "| campaign:", convo.campaign_id);
  console.log("turns so far:", convo.turns.length);
  for (const t of convo.turns) console.log(`  [${t.role}] ${t.body.slice(0, 80)}`);

  const user = await prisma.user.findUniqueOrThrow({
    where: { user_id: convo.created_by_id! },
    select: { user_id: true, user_type: true, is_agency_admin: true, status: true },
  });

  console.log("\n--- replaying 'Athletes' ---");
  try {
    const result = await chatTurn(user, CONVO, "Athletes");
    console.log("status:", result.status);
    console.log("message:", result.assistantMessage);
  } catch (e) {
    console.error("THREW:", (e as Error).name, "-", (e as Error).message);
    console.error((e as Error).stack?.split("\n").slice(0, 8).join("\n"));
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); }).finally(() => prisma.$disconnect());
