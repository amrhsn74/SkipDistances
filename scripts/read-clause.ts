import { prisma } from "../lib/db";
async function main() {
  const c = await prisma.guidelineClause.findFirst({
    where: { clause_code: "NF.2" },
    select: { clause_code: true, title: true, text: true },
  });
  console.log(c?.clause_code, "—", c?.title);
  console.log(c?.text?.slice(0, 400));
}
main().finally(() => prisma.$disconnect());
