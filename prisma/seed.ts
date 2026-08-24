import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import { prisma } from "../lib/db";
import {
  parseGuidelineFile,
  parseGuideHeading,
  GUIDELINES_DIR,
  DATA_DIR,
  AGENCY_STANDARDS_FILE,
} from "./seed/parseGuidelines";
import { isSensitiveSector } from "./seed/sensitiveSector";

type RosterClient = {
  client_id: string;
  name: string;
  industry: string;
  status: string;
  tier: string | null;
  channels: string[];
  brand_guide: string | null;
  account_manager: string | null;
};

// ---------------------------------------------------------------------------
// P1.9 — Markets and occasions
// ---------------------------------------------------------------------------

const MARKETS = [
  { name: "Egypt", country_code: "EG", calendar_system: "gregorian_and_hijri" },
  { name: "Saudi Arabia", country_code: "SA", calendar_system: "gregorian_and_hijri" },
];

/**
 * Occasions per market. `shared_key` marks observances that exist in both
 * markets so resolve_calendar can collapse them into one logical occasion --
 * a dual-market client gets one Ramadan item, not two near-duplicates.
 * National days carry no shared_key and stay market-specific.
 */
const OCCASIONS: Record<
  string,
  Array<{
    name: string;
    category: string;
    date_type: "fixed_gregorian" | "hijri_based";
    month?: number;
    day?: number;
    shared_key?: string;
  }>
> = {
  EG: [
    { name: "Ramadan", category: "religious", date_type: "hijri_based", shared_key: "ramadan" },
    { name: "Eid al-Fitr", category: "religious", date_type: "hijri_based", shared_key: "eid_al_fitr" },
    { name: "Eid al-Adha", category: "religious", date_type: "hijri_based", shared_key: "eid_al_adha" },
    { name: "Islamic New Year", category: "religious", date_type: "hijri_based", shared_key: "islamic_new_year" },
    { name: "Revolution Day", category: "national", date_type: "fixed_gregorian", month: 7, day: 23 },
    { name: "Sinai Liberation Day", category: "national", date_type: "fixed_gregorian", month: 4, day: 25 },
    { name: "Coptic Christmas", category: "religious", date_type: "fixed_gregorian", month: 1, day: 7 },
    { name: "Back to School", category: "seasonal", date_type: "fixed_gregorian", month: 9, day: 1 },
    { name: "Black Friday", category: "retail", date_type: "fixed_gregorian", month: 11, day: 28, shared_key: "black_friday" },
  ],
  SA: [
    { name: "Ramadan", category: "religious", date_type: "hijri_based", shared_key: "ramadan" },
    { name: "Eid al-Fitr", category: "religious", date_type: "hijri_based", shared_key: "eid_al_fitr" },
    { name: "Eid al-Adha", category: "religious", date_type: "hijri_based", shared_key: "eid_al_adha" },
    { name: "Islamic New Year", category: "religious", date_type: "hijri_based", shared_key: "islamic_new_year" },
    { name: "Saudi National Day", category: "national", date_type: "fixed_gregorian", month: 9, day: 23 },
    { name: "Saudi Founding Day", category: "national", date_type: "fixed_gregorian", month: 2, day: 22 },
    { name: "Back to School", category: "seasonal", date_type: "fixed_gregorian", month: 8, day: 20 },
    { name: "Black Friday", category: "retail", date_type: "fixed_gregorian", month: 11, day: 28, shared_key: "black_friday" },
  ],
};

/**
 * Hand-resolved Hijri dates, per architecture §10: a seeded lookup table rather
 * than a live calendar-conversion dependency. Dates are the first day of the
 * observance.
 *
 * Egypt and Saudi Arabia can differ by a day because each announces on local
 * moon sighting -- that is exactly why this is a per-market table rather than
 * one shared date.
 *
 * NEEDS RESEEDING EACH YEAR. 2026 and 2027 are seeded so the demo has a
 * forward-looking window from any date in 2026.
 */
const HIJRI_DATES: Record<string, Record<string, Record<number, string>>> = {
  // Egypt did not sight the crescent on 17 Feb 2026 and began a day after Saudi
  // Arabia -- the real reported outcome, and a concrete example of why this is
  // a per-market table rather than one shared date.
  EG: {
    Ramadan: { 2026: "2026-02-19", 2027: "2027-02-08" },
    "Eid al-Fitr": { 2026: "2026-03-20", 2027: "2027-03-09" },
    "Eid al-Adha": { 2026: "2026-05-27", 2027: "2027-05-16" },
    "Islamic New Year": { 2026: "2026-06-17", 2027: "2027-06-06" },
  },
  SA: {
    Ramadan: { 2026: "2026-02-18", 2027: "2027-02-07" },
    "Eid al-Fitr": { 2026: "2026-03-19", 2027: "2027-03-08" },
    "Eid al-Adha": { 2026: "2026-05-26", 2027: "2027-05-15" },
    "Islamic New Year": { 2026: "2026-06-16", 2027: "2027-06-05" },
  },
};

/** Hero clients seeded into both markets, so the dual-market path has live data. */
const DUAL_MARKET_CLIENTS = new Set(["CL-104", "CL-106", "CL-108"]);

async function seedMarketsAndOccasions() {
  const marketIdByCode: Record<string, string> = {};

  for (const m of MARKETS) {
    const row = await prisma.market.upsert({
      where: { country_code: m.country_code },
      update: { name: m.name, calendar_system: m.calendar_system },
      create: m,
    });
    marketIdByCode[m.country_code] = row.market_id;
  }

  let occasionCount = 0;
  let dateCount = 0;

  for (const [code, list] of Object.entries(OCCASIONS)) {
    const market_id = marketIdByCode[code];

    for (const o of list) {
      const existing = await prisma.occasion.findFirst({
        where: { market_id, name: o.name },
      });

      const occasion = existing
        ? await prisma.occasion.update({
            where: { occasion_id: existing.occasion_id },
            data: {
              category: o.category,
              date_type: o.date_type,
              month: o.month ?? null,
              day: o.day ?? null,
              shared_key: o.shared_key ?? null,
            },
          })
        : await prisma.occasion.create({
            data: {
              market_id,
              name: o.name,
              category: o.category,
              date_type: o.date_type,
              month: o.month ?? null,
              day: o.day ?? null,
              shared_key: o.shared_key ?? null,
            },
          });
      occasionCount++;

      if (o.date_type !== "hijri_based") continue;

      const years = HIJRI_DATES[code]?.[o.name];
      if (!years) {
        throw new Error(
          `No seeded Hijri dates for ${o.name} in ${code}. Hijri occasions must have a resolved date -- see HIJRI_DATES.`,
        );
      }

      for (const [year, iso] of Object.entries(years)) {
        await prisma.occasionDate.upsert({
          where: { occasion_id_year: { occasion_id: occasion.occasion_id, year: Number(year) } },
          update: { gregorian_date: new Date(`${iso}T00:00:00.000Z`), source: "seeded" },
          create: {
            occasion_id: occasion.occasion_id,
            year: Number(year),
            gregorian_date: new Date(`${iso}T00:00:00.000Z`),
            source: "seeded",
          },
        });
        dateCount++;
      }
    }
  }

  console.log(`  markets:       ${MARKETS.length}`);
  console.log(`  occasions:     ${occasionCount}`);
  console.log(`  occasion dates:${dateCount} (hand-seeded Hijri, 2026-2027)`);

  return marketIdByCode;
}

// ---------------------------------------------------------------------------
// P1.10 — Users and assignments
// ---------------------------------------------------------------------------

/**
 * The five account-manager names in clients.json become real staff Users, so
 * Client.account_manager_id points at a row rather than a string. The rest of
 * the demo team is invented -- the roster names creators and leads nowhere.
 */
async function seedUsers(roster: RosterClient[]) {
  const amNames = Array.from(
    new Set(roster.map((c) => c.account_manager).filter(Boolean) as string[]),
  );

  const userIdByName: Record<string, string> = {};

  async function ensureUser(name: string, user_type: string, is_agency_admin = false) {
    const existing = await prisma.user.findFirst({ where: { name, user_type } });
    const row = existing
      ? await prisma.user.update({ where: { user_id: existing.user_id }, data: { is_agency_admin } })
      : await prisma.user.create({ data: { name, user_type, is_agency_admin } });
    userIdByName[name] = row.user_id;
    return row;
  }

  for (const n of amNames) await ensureUser(n, "staff");

  await ensureUser("Hala Mansour", "staff", true); // Agency Admin

  const contentLeads = ["Youssef Adel"];
  const creators = ["Mona Farid", "Ziad Hafez", "Nour Kamal"];
  for (const n of [...contentLeads, ...creators]) await ensureUser(n, "staff");

  // One client contact per hero client, CL-101..108.
  const heroContacts: Record<string, string> = {
    "CL-101": "Rana Fouad",
    "CL-102": "Hisham Adly",
    "CL-103": "Dr. Amira Hassan",
    "CL-104": "Khaled Mostafa",
    "CL-105": "Layla Sherif",
    "CL-106": "Tamer Wagih",
    "CL-107": "Salma Ibrahim",
    "CL-108": "Ahmed Rifaat",
  };
  for (const n of Object.values(heroContacts)) await ensureUser(n, "client_contact");

  console.log(`  users:         ${Object.keys(userIdByName).length}`);
  return { userIdByName, contentLeads, creators, heroContacts };
}

async function seedAssignments(
  userIdByName: Record<string, string>,
  contentLeads: string[],
  creators: string[],
  heroContacts: Record<string, string>,
) {
  let count = 0;

  async function assign(client_id: string, name: string, role_on_client: string) {
    const user_id = userIdByName[name];
    if (!user_id) throw new Error(`No seeded user "${name}"`);
    await prisma.clientAssignment.upsert({
      where: { client_id_user_id_role_on_client: { client_id, user_id, role_on_client } },
      update: {},
      create: { client_id, user_id, role_on_client },
    });
    count++;
  }

  // A content lead replaces the account manager as internal reviewer, but only
  // where assigned -- CL-103 (MedCare) exercises that path, the rest fall back
  // to their account manager.
  await assign("CL-103", contentLeads[0], "content_lead");

  // Creators across the hero clients; several clients share a creator, which is
  // what the "assigned clients only" scoping in Phase 7 has to filter on.
  const creatorMap: Record<string, string[]> = {
    "CL-101": [creators[0], creators[1]],
    "CL-102": [creators[0]],
    "CL-103": [creators[2]],
    "CL-104": [creators[2]],
    "CL-105": [creators[1]],
    "CL-106": [creators[0]],
    "CL-107": [creators[1]],
    "CL-108": [creators[2]],
  };
  for (const [client_id, names] of Object.entries(creatorMap)) {
    for (const n of names) await assign(client_id, n, "content_creator");
  }

  // Exactly one client_approver per client -- the ERD's single-assignment
  // invariant for a client contact (enforced in P2.9).
  for (const [client_id, name] of Object.entries(heroContacts)) {
    await assign(client_id, name, "client_approver");
  }

  console.log(`  assignments:   ${count}`);
}

// ---------------------------------------------------------------------------
// P1.8 — Clients and guidelines
// ---------------------------------------------------------------------------

async function seedAgencyClauses() {
  const clauses = parseGuidelineFile(path.join(GUIDELINES_DIR, AGENCY_STANDARDS_FILE));
  if (clauses.length === 0) throw new Error("Parsed zero agency clauses -- check the parser.");

  for (const c of clauses) {
    // Agency clauses are global and unversioned: brand_guide_version_id is null.
    const existing = await prisma.guidelineClause.findFirst({
      where: { source_type: "agency", clause_code: c.clause_code },
    });
    if (existing) {
      await prisma.guidelineClause.update({
        where: { clause_id: existing.clause_id },
        data: { title: c.title, text: c.text },
      });
    } else {
      await prisma.guidelineClause.create({
        data: { source_type: "agency", brand_guide_version_id: null, ...c },
      });
    }
  }

  console.log(`  agency clauses:${clauses.length}`);
  return clauses.length;
}

async function seedClients(
  roster: RosterClient[],
  marketIdByCode: Record<string, string>,
  userIdByName: Record<string, string>,
) {
  let brandClauseCount = 0;
  let guideCount = 0;

  for (const c of roster) {
    const account_manager_id = c.account_manager ? userIdByName[c.account_manager] ?? null : null;

    await prisma.client.upsert({
      where: { client_id: c.client_id },
      update: {
        name: c.name,
        industry: c.industry,
        status: c.status,
        tier: c.tier,
        channels: JSON.stringify(c.channels ?? []),
        account_manager_id,
        sensitive_sector: isSensitiveSector(c.industry),
      },
      create: {
        client_id: c.client_id,
        name: c.name,
        industry: c.industry,
        status: c.status,
        tier: c.tier,
        channels: JSON.stringify(c.channels ?? []),
        account_manager_id,
        sensitive_sector: isSensitiveSector(c.industry),
      },
    });

    // Markets: every client operates in Egypt (what the roster and brand guides
    // are written for); a few hero clients also operate in Saudi Arabia so the
    // dual-market path is demonstrable with real data.
    const codes = DUAL_MARKET_CLIENTS.has(c.client_id) ? ["EG", "SA"] : ["EG"];
    for (const code of codes) {
      await prisma.clientMarket.upsert({
        where: { client_id_market_id: { client_id: c.client_id, market_id: marketIdByCode[code] } },
        update: {},
        create: { client_id: c.client_id, market_id: marketIdByCode[code] },
      });
    }

    if (!c.brand_guide) continue;

    // A brand guide becomes version 1, already active and client-approved --
    // the seeded starting state. Later versions are created in-app (Phase 4).
    const file = path.join(GUIDELINES_DIR, c.brand_guide);
    if (!fs.existsSync(file)) {
      throw new Error(`Client ${c.client_id} references a missing guide: ${c.brand_guide}`);
    }

    const existingVersion = await prisma.brandGuideVersion.findUnique({
      where: { client_id_version_number: { client_id: c.client_id, version_number: 1 } },
    });

    const version =
      existingVersion ??
      (await prisma.brandGuideVersion.create({
        data: {
          client_id: c.client_id,
          version_number: 1,
          status: "active",
          approved_at: new Date(),
        },
      }));
    guideCount++;

    const clauses = parseGuidelineFile(file);
    if (clauses.length === 0) throw new Error(`Parsed zero clauses from ${c.brand_guide}`);

    for (const cl of clauses) {
      await prisma.guidelineClause.upsert({
        where: {
          brand_guide_version_id_clause_code: {
            brand_guide_version_id: version.brand_guide_version_id,
            clause_code: cl.clause_code,
          },
        },
        update: { title: cl.title, text: cl.text },
        create: {
          source_type: "brand",
          brand_guide_version_id: version.brand_guide_version_id,
          ...cl,
        },
      });
      brandClauseCount++;
    }

    await prisma.client.update({
      where: { client_id: c.client_id },
      data: { active_brand_guide_id: version.brand_guide_version_id },
    });

    const heading = parseGuideHeading(file);
    if (heading && !heading.toLowerCase().includes(c.name.toLowerCase().split(" ")[0])) {
      console.warn(`  ! ${c.client_id} (${c.name}) -> guide titled "${heading}"`);
    }
  }

  console.log(`  clients:       ${roster.length}`);
  console.log(`  brand guides:  ${guideCount}`);
  console.log(`  brand clauses: ${brandClauseCount}`);
}

// ---------------------------------------------------------------------------

async function main() {
  const rosterPath = path.join(DATA_DIR, "clients.json");
  if (!fs.existsSync(rosterPath)) {
    throw new Error(`Missing ${rosterPath} -- Skip_data/ must be present to seed.`);
  }
  const roster: RosterClient[] = JSON.parse(fs.readFileSync(rosterPath, "utf8"));

  console.log("Seeding Skip Studio...\n");

  console.log("P1.9  markets and occasions");
  const marketIdByCode = await seedMarketsAndOccasions();

  console.log("\nP1.10 users and assignments");
  const { userIdByName, contentLeads, creators, heroContacts } = await seedUsers(roster);

  console.log("\nP1.8  guidelines and roster");
  await seedAgencyClauses();
  await seedClients(roster, marketIdByCode, userIdByName);

  console.log("");
  await seedAssignments(userIdByName, contentLeads, creators, heroContacts);

  console.log("\nDone.");
}

main()
  .catch((e) => {
    console.error("\nSeed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
