import "dotenv/config";
import { prisma } from "../lib/db";
import { verifyPassword } from "../lib/domain/password";

let fails = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  -- " + detail : ""}`);
  if (!ok) fails++;
}

async function main() {
  // counts
  check("150 clients", (await prisma.client.count()) === 150);
  check("20 agency clauses", (await prisma.guidelineClause.count({ where: { source_type: "agency" }})) === 20);
  check("40 brand clauses", (await prisma.guidelineClause.count({ where: { source_type: "brand" }})) === 40);
  check("8 brand guide versions", (await prisma.brandGuideVersion.count()) === 8);

  // agency clauses are unversioned
  const versionedAgency = await prisma.guidelineClause.count({ where: { source_type: "agency", NOT: { brand_guide_version_id: null }}});
  check("agency clauses unversioned", versionedAgency === 0);

  // the nullable-FK reality of the roster
  const noGuide = await prisma.client.count({ where: { active_brand_guide_id: null }});
  check("142 clients have no brand guide", noGuide === 142, `${noGuide}`);
  const noAM = await prisma.client.count({ where: { account_manager_id: null }});
  check("CL-109 has no account manager", noAM === 1, `${noAM} client(s)`);

  // sensitive sector, Clause 1.8
  const sens = await prisma.client.findMany({ where: { sensitive_sector: true }, select: { client_id: true, industry: true }});
  check("MedCare + NileBank flagged sensitive", sens.some(c=>c.client_id==="CL-103") && sens.some(c=>c.client_id==="CL-104"),
    sens.map(c=>`${c.client_id}:${c.industry}`).join(", "));
  const fit = await prisma.client.findUnique({ where: { client_id: "CL-101" }});
  check("fitness NOT sensitive", fit!.sensitive_sector === false);

  // markets
  const eg = (await prisma.market.findUnique({ where: { country_code: "EG" }}))!;
  const sa = (await prisma.market.findUnique({ where: { country_code: "SA" }}))!;
  const egCount = await prisma.clientMarket.count({ where: { market_id: eg.market_id }});
  const saCount = await prisma.clientMarket.count({ where: { market_id: sa.market_id }});
  check("all 150 clients operate in Egypt", egCount === 150, `${egCount}`);
  check("3 hero clients dual-market", saCount === 3, `${saCount} in SA`);
  const everyClientHasMarket = (await prisma.client.count({ where: { markets: { none: {} }}})) === 0;
  check("every client has >=1 market", everyClientHasMarket);

  // occasions: shared collapse + no cross-market leak
  const ramadan = await prisma.occasion.findMany({ where: { shared_key: "ramadan" }, include: { market: true, dates: true }});
  check("Ramadan exists in both markets", ramadan.length === 2, ramadan.map(o=>o.market.country_code).join(","));
  const egRam = ramadan.find(o=>o.market.country_code==="EG")!.dates.find(d=>d.year===2026)!;
  const saRam = ramadan.find(o=>o.market.country_code==="SA")!.dates.find(d=>d.year===2026)!;
  check("EG Ramadan 2026 = 2026-02-19", egRam.gregorian_date.toISOString().slice(0,10) === "2026-02-19", egRam.gregorian_date.toISOString().slice(0,10));
  check("SA Ramadan 2026 = 2026-02-18", saRam.gregorian_date.toISOString().slice(0,10) === "2026-02-18", saRam.gregorian_date.toISOString().slice(0,10));
  check("per-market dates differ (moon sighting)", egRam.gregorian_date.getTime() !== saRam.gregorian_date.getTime());

  const saOcc = await prisma.occasion.findMany({ where: { market_id: sa.market_id }});
  check("Revolution Day absent from Saudi", !saOcc.some(o=>o.name==="Revolution Day"));
  const egOcc = await prisma.occasion.findMany({ where: { market_id: eg.market_id }});
  check("Saudi National Day absent from Egypt", !egOcc.some(o=>o.name==="Saudi National Day"));

  // every hijri occasion has resolved dates
  const hijri = await prisma.occasion.findMany({ where: { date_type: "hijri_based" }, include: { dates: true }});
  check("every hijri occasion has 2026+2027 dates", hijri.every(o=>o.dates.length===2), `${hijri.length} occasions`);

  // retrieval scoping precondition: one client's clauses never reachable from another's guide
  const cr = await prisma.client.findUnique({ where: { client_id: "CL-102" }, include: { brand_guide_versions: { include: { clauses: true }}}});
  const codes = cr!.brand_guide_versions.flatMap(v=>v.clauses.map(c=>c.clause_code));
  check("Cairo Roast guide holds only CR.* clauses", codes.every(c=>c.startsWith("CR.")), codes.join(","));

  // client_approver invariant precondition
  const approvers = await prisma.clientAssignment.groupBy({ by: ["user_id"], where: { role_on_client: "client_approver" }, _count: true });
  check("each client_approver has exactly 1 assignment", approvers.every(a=>a._count===1), `${approvers.length} approvers`);

  // content lead present for CL-103 only
  const leads = await prisma.clientAssignment.findMany({ where: { role_on_client: "content_lead" }});
  check("one content lead, on CL-103", leads.length===1 && leads[0].client_id==="CL-103");

  // --- P2.A: credentials -----------------------------------------------------
  const users = await prisma.user.findMany({
    select: { user_id: true, name: true, email: true, password_hash: true, status: true },
  });
  check("every user has an email", users.every(u => !!u.email), `${users.length} users`);
  check("emails are unique", new Set(users.map(u => u.email)).size === users.length);
  check("emails are lowercased", users.every(u => u.email === u.email.toLowerCase()));

  const invited = users.filter(u => u.status === "invited");
  check("exactly one contact is invited", invited.length === 1, invited.map(u => u.email).join(", "));
  check("the invited contact has no password", invited.every(u => u.password_hash === null));

  const active = users.filter(u => u.status === "active");
  check("every active user has a password hash", active.every(u => !!u.password_hash), `${active.length} active`);
  check(
    "stored hashes are scrypt, not plaintext",
    active.every(u => u.password_hash!.startsWith("scrypt$") && !u.password_hash!.includes("skipstudio-dev")),
  );

  const verifies = await verifyPassword("skipstudio-dev", active[0]?.password_hash);
  check("the seeded dev password verifies", verifies);

  console.log(fails === 0 ? "\nAll checks passed." : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}
main().finally(() => prisma.$disconnect());
