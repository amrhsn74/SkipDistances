# Skip Studio — AI-Powered Content Operations Platform

A web platform that runs a content agency's production and publishing for every
client in one place: campaign intake, a guarded content engine that drafts a
full multi-form plan grounded in that client's own rules, two-stage reversible
approval, scheduled publishing to Instagram, and performance analytics.

Two guarantees hold everywhere, enforced in application code and never in a
prompt:

- **Nothing is scheduled or published without both internal and client approval
  currently recorded** — re-checked atomically at the moment of publishing, not
  just when the post was scheduled.
- **Nothing is drafted that breaks a rule** — every draft cites the specific
  clause it was written under.

## Design documents

The source of truth for *what* this is. Read in this order:

| Document | What it covers |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Product requirements — users, scope, success criteria |
| [docs/architecture.md](docs/architecture.md) | Components, the guarded engine, the approval gate, governance, publishing |
| [docs/data-schema-erd.md](docs/data-schema-erd.md) | Every entity, field, and relationship |
| [docs/project-plan.md](docs/project-plan.md) | The build sequence — source of truth for *what order* |

## Stack

Next.js 14 (App Router) · TypeScript · Prisma 7 · SQLite · Tailwind ·
Gemini (`@google/genai`) · Instagram Graph API

SQLite and local file storage keep the project runnable with zero external
setup beyond a Gemini API key.

## Getting started

Requires Node 20+ (developed on 22).

```bash
npm install
cp .env.example .env      # then fill in GEMINI_API_KEY
npm run db:migrate        # create the database and apply migrations
npm run db:seed           # load the roster, guidelines, markets and occasions
npm run db:verify         # confirm the seed is correct
npm run dev               # http://localhost:3000
```

`GEMINI_API_KEY` is only needed from Phase 3 onward — the data and domain layers
run without it. Get one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

### Scripts

| Script | Does |
|---|---|
| `npm run dev` | Dev server on :3000 |
| `npm run db:migrate` | Apply migrations (creates `prisma/dev.db`) |
| `npm run db:seed` | Seed roster, guidelines, markets, occasions, users |
| `npm run db:verify` | Assert the seeded data holds its invariants |
| `npm run db:studio` | Browse the database in Prisma Studio |
| `npm run db:reset` | Drop and rebuild the database, then reseed |

## Signing in

Every role signs in — there is no anonymous route. The seed creates accounts for
all five roles with a **known development password**, so a walkthrough does not
begin with a password reset:

```
password: skipstudio-dev
```

That is a committed development credential, not a secret. Nothing here is
deployed anywhere reachable, and the value is printed by `npm run db:seed`.

Emails are derived from names — `Sara Selim` → `sara.selim@skipstudio.test`:

| Role | Example |
|---|---|
| Account Manager | `sara.selim@skipstudio.test` |
| Content Lead | `youssef.adel@skipstudio.test` |
| Content Creator | `mona.farid@skipstudio.test` |
| Client (CL-101) | `rana.fouad@skipstudio.test` |
| Agency Admin | `hala.mansour@skipstudio.test` |

**One account is deliberately left un-activated.** `ahmed.rifaat@skipstudio.test`
(StayEasy, CL-108) has `status = invited` and no password at all, so the OTP flow
is demonstrable end to end against seeded data: their account manager issues a
one-time code, the code is shown on screen to pass on, and the contact redeems it
and sets their own password before reaching anything.

## Source data

`data/` is the provided input, treated as read-only:

- **`clients.json`** — 150-client roster. Only the 8 hero clients (CL-101–108)
  have a brand guide; the rest are governed by agency standards alone. CL-109 is
  inactive with no account manager — the unknown/inactive-client path is real
  data, not a synthetic case.
- **`guidelines/`** — the RAG corpus: 20 agency clauses + 40 brand clauses across
  8 guides. Clause codes (`0.6`, `1.3`, `CR.4`, `NF.2`) are the citation
  vocabulary the evaluation grades against, so they are parsed verbatim.
- **`briefs/`** + **`answer_key.json`** — 27 briefs and their expected outcomes.
  Read directly by the tests rather than copied, so a fixture can never drift
  from the data the engine is graded against. They are deliberately *not* seeded
  as campaigns.

The roster and the guideline corpus are **seeded into the database**, and the
engine retrieves them per-request from there — the model is never handed the
corpus to hold in its own memory. That is what makes cross-client leakage
structurally impossible rather than a matter of model behaviour.

## Project layout

```
app/                 Next.js App Router — role routes, API routes
lib/
  db.ts              Prisma client singleton + shared Prisma types
  config/            Filesystem paths, environment access
  domain/            Pure, unit-tested rules (Phase 2)
  engine/            The guarded content engine (Phase 3)
  llm/               Gemini wrapper (Phase 3)
  instagram/         Graph API client + OAuth (Phase 9)
  generated/prisma/  Generated Prisma client (gitignored)
prisma/
  schema.prisma      All 21 entities — a living copy of the ERD
  seed.ts            Roster, guidelines, markets, occasions, users
tests/fixtures/      Loader for the 27 evaluation briefs + answer key
scripts/             Seed verification; scheduler and analytics workers later
data/                Provided source data (read-only)
docs/                PRD, architecture, ERD, project plan
```

Dependencies point **inward** — `app/` → `engine/` → `domain/` → `db`. Enforced
by `no-restricted-imports` in `.eslintrc.json`, so a violation fails
`npm run lint`: `lib/domain` cannot import the engine, the Gemini SDK, or React,
which is what keeps the rules the assignment is graded on unit-testable without
a network. Only `lib/db.ts` imports the generated Prisma client.

## Build status

Following [docs/project-plan.md](docs/project-plan.md), one phase per layer.

- [x] **Phase 1** — Data layer: schema (21 entities) + seed
- [x] **Phase 2** — Domain / rules layer
- [ ] **Phase 3** — Guarded Content Engine
- [ ] **Phase 4** — API layer
- [ ] **Phase 5** — Presentation shell + Account Manager dashboard
- [ ] **Phase 6** — Two-stage review screen
- [ ] **Phase 7** — Content Creator dashboard
- [ ] **Phase 8** — Client dashboard
- [ ] **Phase 9** — Publishing layer
- [ ] **Phase 10** — Analytics layer
- [ ] **Phase 11** — Admin dashboard + audit trail completeness
- [ ] **Phase 12** — Evaluation harness + full test pass
- [ ] **Phase 13** — Polish + demo dry run

## Notes

**Markets.** Egypt and Saudi Arabia are both seeded; an account manager picks one
or both per client. Egypt is what the provided roster and brand guides are
written for (Cairo Roast, NileFit's "Cairo and Alexandria" audience, and agency
Clause 1.3's own "Egypt's leading" example). A client operating in both gets one
content plan, with each item either market-neutral (produced once) or tagged to a
single market and scheduled against that market's own date.

**Hijri dates need reseeding each year.** Ramadan and the two Eids are resolved
from a hand-maintained table in `prisma/seed.ts` rather than computed, so there
is no calendar-conversion dependency. 2026 and 2027 are seeded. The two markets
carry different dates for the same observance — Egypt began Ramadan 2026 a day
after Saudi Arabia — which is exactly why the table is per-market.

**Known advisories.** `npm audit` reports advisories against Next.js 14 with no
14.x fix available (they are addressed in Next 16). This app runs locally
against SQLite with no untrusted traffic, so none are reachable here; upgrading
is a post-project change.
