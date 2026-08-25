# Implementation Plan — Skip Studio Content Operations Platform

This plan turns the PRD, System Architecture, and Data Schema (ERD) into a buildable sequence: one architectural layer per phase, small commit-sized tasks within each phase, later phases building strictly on top of earlier ones. Each task below is scoped to be one Claude Code session and one git commit.

---

## 0. Decisions locked in before Phase 1

These aren't in the design docs yet because they're implementation-only choices, not product requirements — but everything below depends on them, so confirm or override before Phase 1 starts.

| Decision | Choice | Why |
|---|---|---|
| **Stack** | Next.js 14 (App Router) + TypeScript + Prisma + SQLite + Tailwind | One language end to end, file-based routing gives the URL-routing requirement for free, Prisma's schema file doubles as a living copy of the ERD, SQLite needs zero setup for a one-week solo build. |
| **LLM** | Gemini Flash-Lite (`gemini-3.1-flash-lite`) via the `@google/genai` npm package, one `GEMINI_API_KEY` in `.env` | Matches what you specified; current model name as of this writing — Google has been retiring older Gemini versions on a rolling basis, so this is worth reconfirming against `ai.google.dev/gemini-api/docs/models` if there's a gap before you build. |
| **Authentication** | Real login for **all five roles**. Email + password, server-side sessions, `password_hash` never leaving the server. A client contact is created by their account manager, who is shown a **one-time code on screen** to pass on; the client redeems it once and must set their own password before reaching anything. | Access scoping is a graded requirement, and it cannot be demonstrated by a dropdown that anyone can change. Real credentials make "this client cannot see that client's data" provable rather than asserted. |
| **Access scope by role** | Client → own data only. Account Manager → their assigned clients only. Content Creator → their assigned clients only (via `ClientAssignment`). Content Lead → all clients. Agency Admin → all clients. | Matches PRD §2: a creator needs "just their assigned clients' in-progress work". Lead and Admin are the two cross-client roles; every other route is scoped by the session's user, not by a query parameter. |
| **Markets** | Two seeded rows, Egypt and Saudi Arabia, joined to clients through `ClientMarket`; an account manager picks one or both per client. One campaign produces one plan; each `ContentItem` is either market-neutral or tagged to a single market. | The seeded roster and brand guides are written for Egypt (Cairo Roast, NileFit's "Cairo and Alexandria", Clause 1.3's "Egypt's leading"), so Egypt has to be real rather than relabelled. Saudi Arabia alongside it makes the multi-market path demonstrable instead of theoretical. |
| **File storage** | Local filesystem under `/public/uploads/{media,references}` | No cloud credentials needed for a demo; swappable later. |
| **Background jobs** | Two standalone scripts, `scripts/scheduler.ts` and `scripts/analytics.ts`, run in a second terminal alongside `npm run dev` | Next.js API routes aren't long-running processes; a real cron/queue is overkill for this scope. |

If any of these don't match what you want, say so before Phase 1 — the whole sequence below assumes them.

---

## 1. Repo conventions

- **One task below = one commit.** Commit message prefix by phase: `P1: seed market and occasion data`, `P4: approval gate reads most-recent-per-stage`, etc.
- Trunk-based is fine for a solo project — no need for feature branches unless you want cleaner review checkpoints for yourself.
- Every phase ends in a **working, runnable state** — nothing left half-wired between phases, even if later phases will extend it.
- Tests land in the same commit as the code they test, not a separate "add tests" commit — this is what makes the final evaluation phase a confirmation pass, not a scramble.

---

## Phase map

| Phase | Layer | Depends on |
|---|---|---|
| 1 | Data layer — schema + seed | — |
| 2 | Domain / rules layer (pure functions, unit-tested) | 1 |
| 3 | Guarded Content Engine (Gemini integration) | 1, 2 |
| 4 | API layer | 1, 2, 3 |
| 5 | Presentation shell + Account Manager dashboard | 4 |
| 6 | Two-stage review screen | 4, 5 |
| 7 | Content Creator dashboard + reference attachments | 4, 5 |
| 8 | Client dashboard | 4, 5 |
| 9 | Publishing layer | 4, 6 |
| 10 | Analytics layer | 9 |
| 11 | Admin dashboard + audit trail completeness | 2–10 |
| 12 | Evaluation harness + full test pass | everything |
| 13 | Polish + demo dry run | everything |

---

## Phase 1 — Data layer

**Goal:** every entity from the ERD exists as a real table, and the database is seeded with everything the engine and UI need to run against real data from Phase 2 onward.

- [x] `P1.1` — Init repo: `npx create-next-app` (TypeScript, App Router, Tailwind), install Prisma, `prisma init` with SQLite provider. Commit scaffold.
- [x] `P1.2` — `.env.example` with `DATABASE_URL`, `GEMINI_API_KEY`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` (placeholders). Add `.env` to `.gitignore`.
- [x] `P1.3` — `prisma/schema.prisma`, part 1: `User`, `ClientAssignment`, `Client`, `Market`, `ClientMarket`. Migrate. `Client.account_manager_id` and `Client.active_brand_guide_id` are both nullable — CL-109 has no account manager, and 142 of 150 clients have no brand guide.
- [x] `P1.4` — `prisma/schema.prisma`, part 2: `BrandGuideVersion`, `GuidelineClause`, `Occasion`, `OccasionDate`. Migrate.
- [x] `P1.5` — `prisma/schema.prisma`, part 3: `Campaign`, `ContentItem`, `ContentItemCitation`, `MediaAsset`, `ReferenceAttachment`. Migrate.
- [x] `P1.6` — `prisma/schema.prisma`, part 4: `Approval`, `Flag`, `AuditLog`. Migrate.
- [x] `P1.7` — `prisma/schema.prisma`, part 5: `PlatformConnection`, `MetricSnapshot`, `PostRequest`, `Comment`. Migrate. At this point every table in the ERD doc exists — diff the schema against the doc once, here, before building anything on top of it.
- [x] `P1.8` — `prisma/seed.ts`, part 1: parse and load `clients.json` (150 clients) and the 8 brand-guide markdown files + `00_agency_standards.md` into `Client` and `GuidelineClause`/`BrandGuideVersion`. Only the 8 hero clients (CL-101–108) have a `brand_guide`; the other 142 are seeded with `active_brand_guide_id = null` and are governed by agency clauses alone. Agency clauses parse as `source_type = agency` with a null `brand_guide_version_id` (codes `0.1`–`2.5`); brand clauses parse per-guide (`NF.*`, `CR.*`, `MC.*`, `NB.*`, `LF.*`, `TN.*`, `GG.*`, `SE.*`) — the clause codes are the citation vocabulary `answer_key.json` is graded against, so parse them exactly.
- [x] `P1.9` — `prisma/seed.ts`, part 2: seed `Market` (two rows — Egypt/EG, Saudi Arabia/SA) and write `ClientMarket` rows (all seeded clients default to Egypt, which is what the roster and brand guides are written for; a handful of hero clients get both, so the dual-market path has live data to demo). Seed `Occasion` + `OccasionDate` for both markets: fixed Gregorian per market (Egypt — Revolution Day Jul 23, Sinai Liberation Apr 25; Saudi — National Day Sep 23, Founding Day Feb 22) and hand-resolved 2026 Hijri dates for Ramadan, Eid al-Fitr, Eid al-Adha in **each** market, tied together by `shared_key`.
- [x] `P1.10` — `prisma/seed.ts`, part 3: seed demo `User` rows for all five roles (2–3 Account Managers, 1 Content Lead, 2–3 Content Creators, one `client_contact` per hero client CL-101–108, one Agency Admin), and `ClientAssignment` rows wiring them up. These are the accounts sign-in resolves against; `P2.A` gives them credentials.
- [x] `P1.11` — Load the 27 brief `.txt` files and `answer_key.json` into `/fixtures/briefs/` (not seeded into the DB as real campaigns — these are test fixtures for Phase 3 and Phase 12, kept as files).
- [x] `P1.12` — `README.md`: how to install, set `.env`, run migrations, seed, and start dev. This gets extended every phase, not written once at the end.

---

## Phase 2 — Domain / rules layer

**Goal:** every rule that must "never get wrong" exists as a pure, unit-tested function before any UI or LLM call can reach it. Nothing here talks to Gemini or Instagram.

- [x] `P2.1` — `lib/domain/auditLog.ts`: `writeAudit(entityType, entityId, action, performedById, details)`. Every later domain function that mutates state calls this — write it first so audit trail is a foundational habit, not a retrofit.
- [x] `P2.2` — `lib/domain/clientResolution.ts`: `resolveClient(clientId)` → active client, or a typed `FLAG` result citing Clause 0.6 for unknown/inactive. Unit tests: known-active, known-inactive, unknown ID.
- [x] `P2.3` — `lib/domain/completeness.ts`: `checkBriefComplete(brief)` → pass, or `REQUEST_INFO` citing Clause 0.5 with the missing fields named. Required fields per Clause 0.5 are client, objective, audience, channels. Unit tests against the seeded fixture briefs (B-012, B-013 are incomplete on purpose).
- [x] `P2.3a` — `lib/domain/substantiation.ts`: `checkSubstantiation(text)` → `REQUEST_INFO` citing **Clause 1.3** when a superlative ("the best", "#1", "leading", "number one") appears with no cited source in the brief. This is the *second, item-level* REQUEST_INFO path and it is easy to miss — `answer_key.json` has three REQUEST_INFO briefs and only two of them are Clause 0.5. B-014 ("position StayEasy as the best hotel chain in Egypt", explicitly noting no award is cited) is Clause 1.3, and `P12.1` fails on it if only the brief-level 0.5 path exists. Unit tests: B-014's text → REQUEST_INFO/1.3; the same claim plus a cited award → pass.
- [x] `P2.4` — `lib/domain/retrievalScope.ts`: `getGuidelinesForClient(clientId)` → that client's active `BrandGuideVersion` clauses + all agency clauses, and nothing else. Must handle a client with no active guide (the majority — 142 of 150) by returning agency clauses alone, never another client's. Unit tests: a second client's clauses never appear regardless of client count; a guide-less client returns agency-only rather than throwing.
- [x] `P2.5` — `lib/domain/sensitiveSector.ts`: `isSensitiveSector(industry)` → boolean, drives `compliance_review_required` per Clause 1.8. `industry` is free text with 18 distinct values in the roster, so match on a normalized form, not equality. Unit tests: `healthcare`, `financial services`, `government`, and a non-sensitive value.
- [x] `P2.6` — `lib/domain/calendar.ts`: `resolveOccasions(marketIds[], dateRange)` — accepts every market a client operates in, resolving `hijri_based` occasions via `OccasionDate` lookup and `fixed_gregorian` via month/day. Collapses occasions sharing a `shared_key` into one entry carrying each market's resolved date; leaves unshared ones market-tagged. Unit tests: the Ramadan/Eid lookups specifically (a naive date-math implementation gets these wrong); a dual-market client yields one Ramadan entry, not two; Egypt's Revolution Day never appears for a Saudi-only client.
- [x] `P2.7` — `lib/domain/statusMachine.ts`: the full `ContentItem.status` transition table — what's a legal transition from each state, and what triggers a reset to `drafted`. This is the highest-value file in the whole project to get right; write its tests before its implementation.
  - [x] `P2.7a` — Legal forward transitions (drafted → … → published).
  - [x] `P2.7b` — Reset-on-edit: content edit or `scheduled_date` change at `internal_approved` or later → `drafted`.
  - [x] `P2.7c` — Reset-on-decline, symmetric: either `internal` or `client` stage decline, at `pending_*_review`, `internal_approved`, `client_approved`, or `scheduled` → `drafted`. Not legal at `publishing`/`published`.
- [x] `P2.8` — `lib/domain/gate.ts`: `canSchedule(contentItemId)` — reads the **most recent** `Approval` row per `(contentItemId, stage)`, returns true only if both are currently `approve`. This is the function the whole assignment is graded on; give it the most thorough test file in the project:
  - [x] both approved → true
  - [x] one declined → false
  - [x] approved then later declined (same stage) → false (proves most-recent-per-stage, not any-ever)
  - [x] declined then later re-approved → true
  - [x] no rows at all → false
- [x] `P2.9` — `lib/domain/clientContactInvariant.ts`: enforce that a User assigned `role_on_client = client_approver` has at most one `ClientAssignment` row ever (the ERD's unique constraint is on the assignment role — `client_contact` is the `user_type`; don't conflate them or the test asserts nothing). Unit test: second assignment attempt throws/rejects.
- [x] `P2.10` — `lib/domain/overrideDetection.ts`: simple pattern check on brief text for bypass language ("skip review", "already approved", "pre-approved", "trust me") → sets `override_attempt_detected`, does not block drafting. Unit test against B-024/B-025-style text.

### Identity — accounts, sign-in, and scope

Every role signs in. This comes before the governance tasks because "who is asking" is the input to both role assignment and the permission table — a capability check against an unauthenticated request has nothing to check.

Needs a schema migration first: `User.email` / `password_hash` / `must_change_password` / `status` / `last_login_at`, plus `LoginOtp` and `Session`. The seed gains known credentials for the demo staff and hero-client contacts, so a walkthrough is possible without a password-reset dance.

- [x] `P2.A` — Schema migration + seed: the `User` columns above, `LoginOtp`, `Session`. Seed every demo user with a known development password (documented in the README, obviously not a real secret), and leave one hero-client contact in `invited` status so the OTP flow is demonstrable end to end. `npm run db:verify` gains assertions: every seeded user has an email, emails are unique, and exactly one contact is `invited`.
- [x] `P2.B` — `lib/domain/password.ts`: hash and verify. Use `node:crypto` `scrypt` — no new dependency, and it is a real KDF rather than a fast hash. Constant-time comparison. Unit tests: a hash never equals its input, verification succeeds for the right password and fails for a near-miss, two hashes of the same password differ (per-hash salt).
- [x] `P2.C` — `lib/domain/otp.ts`: `issueOtp(userId, byAccountManagerId)` returns the **plaintext code once**, to be displayed on screen, and stores only its hash. `redeemOtp(email, code)` verifies, checks expiry, marks it consumed, and sets `must_change_password`. Unit tests: a code works exactly once; an expired code fails; a wrong code fails; redeeming does not itself grant a session; the plaintext is never persisted.
- [x] `P2.D` — `lib/domain/session.ts`: `createSession` / `resolveSession` / `revokeSession`. Token stored hashed, so a leaked table yields no usable sessions. Unit tests: a revoked or expired session resolves to null; a `disabled` user's session stops resolving immediately.
- [x] `P2.E` — `lib/domain/accessScope.ts`: the one place scope is decided. `visibleClientIds(user)` → own client for a client contact, `account_manager_id` matches for an AM, `ClientAssignment` rows for a creator, all clients for a content lead or admin. Every scoped query in Phases 4–10 calls this rather than writing its own `where`. Unit tests per role against the seeded roster, including that an AM sees none of another AM's clients.

### Governance — Admin oversight

The Admin is the accountability role: they assign who works on what, and they are who misuse is surfaced to. The ERD already carries `User.is_agency_admin`, `ClientAssignment`, `AuditLog` and `Flag.flag_type` — these tasks make them behave rather than merely exist.

- [x] `P2.11` — `lib/domain/roleAssignment.ts`: the Admin's actual power. `assignRole(clientId, userId, role, byAdminId)` / `reassignAccountManager(clientId, userId, byAdminId)` / `removeAssignment(...)`, each rejecting a non-admin caller, each writing an `AuditLog` row naming who changed what. Enforces `P2.9`'s single-`client_approver` invariant on the write path rather than trusting callers. Unit tests: admin succeeds; non-admin rejected; reassignment leaves an audit trail; second client_approver rejected.
- [x] `P2.12` — `lib/domain/misuse.ts`: one `raiseFlag(...)` entry point for everything the Admin should see, so misuse detection isn't scattered across layers. Covers all five categories agreed with the project owner:
  - [x] `approval_override_attempt` — bypass language in a brief or a `PostRequest` comment (reuses `P2.10`; the comment path is the one the PRD says carries no authority, so an attempt there is still recorded)
  - [x] `role_boundary_violation` — a user attempting what their role forbids: a non-creator attaching a reference, a creator triggering publish, a client contact reaching another client. Currently these would be rejected silently; each rejection becomes a flag
  - [x] `cross_client_data` — any query that would have returned another client's content, guide or analytics. Structurally impossible per `P2.4`, so a flag here means a real bug or a real attempt — it is a tripwire, not a routine path
  - [x] `approval_churn` — an item declined more than N times, or approved-then-revoked repeatedly. A process signal rather than a rule breach; kept low-severity so it does not drown the others
  - [x] `off_task_generation` — a creator using the regeneration prompt for something unrelated to the client's content (see `P3.11`)
  - [x] Requires a `Flag.flag_type` widening beyond the ERD's six values — update `docs/data-schema-erd.md` in the same commit, and add a `severity` column so the Admin view can rank real breaches above churn
- [x] `P2.13` — `lib/domain/permissions.ts`: one table of who may do what, derived from the PRD §9 roles, so every route and domain function asks the same question instead of re-deriving it. `can(user, action, context)`, using `P2.E`'s `visibleClientIds` for anything client-scoped. Every denial routes through `P2.12`'s `role_boundary_violation`. Unit tests per role against the capability matrix in `docs/architecture.md` §9 — including that an account manager is refused on a client they do not manage.

---

## Phase 3 — Guarded Content Engine

**Goal:** the six-step pipeline plus item-level regeneration, calling Gemini only where Phase 2 says a decision is genuinely generative — everything else is Phase 2 functions.

- [x] `P3.1` — `lib/llm/gemini.ts`: one thin wrapper around `@google/genai`. Reads `GEMINI_API_KEY` from env, one function for text+schema calls, one that also accepts an inline image for vision input. No prompt-template abstraction, no framework — a single file you can read top to bottom.
  ```ts
  import { GoogleGenAI } from '@google/genai';
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  export async function generateStructured<T>(prompt: string, schema: object, imageBase64?: string) {
    const parts: any[] = [{ text: prompt }];
    if (imageBase64) parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } });
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: [{ role: 'user', parts }],
      config: { responseMimeType: 'application/json', responseSchema: schema },
    });
    return JSON.parse(response.text) as T;
  }
  ```
- [x] `P3.2` — `lib/engine/analyzeBrief.ts`: Gemini call extracting client, objective, audience, channels, deliverables from raw brief text into a typed shape. Test against all 27 fixture briefs — assert extraction doesn't silently drop a field a human can see in the text.
- [x] `P3.3` — `lib/engine/orchestrator.ts`, step 2–3: wire in `lookupClient` (Phase 2 `resolveClient`) and `checkComplete` (Phase 2). No Gemini call in this commit — prove the flag/request-info short-circuits work before generation is even reachable.
- [x] `P3.4` — `lib/engine/resolveCalendar.ts`: thin wrapper calling Phase 2 `resolveOccasions` for the client's market and the campaign's planning window.
- [x] `P3.5` — `lib/engine/searchGuidelines.ts`: thin wrapper calling Phase 2 `getGuidelinesForClient`.
- [x] `P3.6` — `lib/engine/generatePlan.ts`: the main drafting call — Gemini, given the brief, the retrieved clauses, and resolved occasions, returns a multi-form plan (post/image/video/reel/photoshoot briefs) with a clause citation per item. Structured output schema enforces every item names at least one `clause_id`, and carries a `market` field that is either null (evergreen or shared-occasion — produced once) or one of the client's markets (written around that market's own occasion, scheduled against that market's date). Validate the returned market against `ClientMarket` in code — never trust the model to scope it.
- [x] `P3.7` — `lib/engine/complianceCheck.ts`: after generation, check each proposed item against the retrieved clauses (a second, smaller Gemini call, or — where possible — deterministic keyword/pattern checks for the sharpest rules, like Clause 1.1/1.2/1.4 language). Runs Phase 2's `checkSubstantiation` (`P2.3a`) for the Clause 1.3 case. Per-item outcome: draft, flag, or request-info.
- [x] `P3.8` — `lib/engine/queueOrFlag.ts`: persists `ContentItem` rows, `ContentItemCitation` rows, and `Flag` rows from the previous step's outcomes; sets `Campaign.compliance_review_required` via Phase 2 `isSensitiveSector`.
- [x] `P3.9` — `lib/engine/orchestrator.ts`, finished: `runIntake(campaignId)` chains all six steps end to end. Integration test: run all 27 fixture briefs through it, log actual vs. `answer_key.json` decision — don't need 100% yet, this is the first pass; the real evaluation is Phase 12.
- [x] `P3.10` — `lib/engine/regenerateItem.ts`: the narrower creator-triggered path — skips brief-level steps, re-runs `searchGuidelines` + generation + compliance check for one `ContentItem`, accepts optional `ReferenceAttachment` rows (image as vision input, PDF/doc text-extracted into the prompt). On success, calls Phase 2 `statusMachine` reset logic if the item was already `internal_approved` or later.
- [x] `P3.11` — `lib/engine/onTaskCheck.ts`: the creator-facing engine is a company resource, not a general chatbot. Before a regeneration prompt reaches Gemini, check it is actually about producing content for *this* `ContentItem`'s client — a cheap deterministic pass first (does it reference the item, the brand, the deliverable at all), then the generation call itself returns a `on_task` boolean it must justify. Off-task prompts are refused, cost nothing further, and raise `off_task_generation` via `P2.12` for the Admin. Two failure modes to keep apart in tests: a *creative* prompt that reads oddly but is genuinely about the deliverable must pass, while "write my CV" or "explain quantum physics" must not. False positives here block real work, so the deterministic pass only ever *allows*; only the model's own judgment refuses.

---

## Phase 4 — API layer

**Goal:** every engine and domain capability is reachable over HTTP, with no business logic living in the route handlers themselves — they call Phase 2/3 functions and return results.

- [x] `P4.1` — `app/api/clients/route.ts`: `GET` (list, roster) and `POST` (create — full field set including `market_id`).
- [x] `P4.2` — `app/api/campaigns/route.ts`: `POST` — accepts a brief, calls `runIntake`, returns the result.
- [x] `P4.3` — `app/api/content-items/[id]/regenerate/route.ts`: `POST` — accepts prompt text + optional file upload(s), writes `ReferenceAttachment` rows, calls `regenerateItem`.
- [x] `P4.4` — `app/api/content-items/[id]/approvals/route.ts`: `POST` — accepts `{ stage, decision, comment, decidedById }`, writes an `Approval` row, re-runs the status machine. This one endpoint serves approve, decline, and late-revoke — they're the same action at the domain layer, per Phase 2.
- [x] `P4.5` — `app/api/post-requests/route.ts`: `POST` (client creates) + `GET` (queue, scoped), `PATCH /[id]` (client edits or withdraws while `new`), `PATCH /[id]/convert` (account manager takes, converts, or declines — conversion calls `submitBrief`, the same function `P4.2` calls). Wider than originally planned: PRD §7's open question was answered — a client **can** edit or withdraw a request before review — so the edit/withdraw path and the `withdrawn` status landed here rather than waiting for Phase 8. The AM takes a request via an explicit `under_review` action, which is what closes the client's edit window.
- [x] `P4.6` — `app/api/brand-guides/route.ts`: `POST` new version, `POST .../approve` (client approval activates it). Also `PATCH` (author submits a draft for approval) and `GET` (version history, scoped) — the submit step is what closes the account manager's edit window, and without it a draft could only reach the client by being born `pending_client_approval`. The approve route serves decline too, for the same reason `P4.4` serves approve and decline together.
- [x] `P4.7` — `app/api/comments/route.ts`: `POST` — on a `PostRequest` or `ContentItem`. No status side-effects, ever. The asserting test grew past one line on purpose: the cases that matter are the ones where a comment most *looks* like a decision ("approved, go ahead", a withdrawal in prose, an override attempt, a message on a scheduled item), and each snapshots status + gate verdict + approval count before and after. Bypass language is flagged and still changes nothing — Clause 0.3's two halves. Also `GET` to read a thread back, scoped the same way.
- [x] `P4.8` — `app/api/summary/route.ts`: `GET` — counts panel data grouped by client, status, market, **and upcoming occasion** (the plan line omitted occasion; PRD §5's success criterion requires all three axes, so it is built here). `lib/domain/summary.ts` takes scope as a parameter rather than deriving it, so `P11.5` reuses the identical query unscoped instead of growing a second one. Adds an `awaiting` breakdown — what needs a human, as distinct from history — which is what `P9.6` surfaces `publish_failed` through.

---

## Phase 5 — Presentation shell + Account Manager dashboard

**Goal:** the routing structure exists, and the first full-loop dashboard (client creation → brief intake → queue) is usable end to end.

- [ ] `P5.1` — App Router shell: `app/AccountManager/`, `app/ContentLead/`, `app/Creator/`, `app/Client/`, `app/Admin/` layout folders, shared nav/header component, empty pages.
- [ ] `P5.2` — Sign-in page + session middleware: one login screen for all roles, redirecting to the role's home route. Middleware resolves `P2.D`'s session on every request and sends an unauthenticated visitor to sign-in; a user with `must_change_password` is sent to the password screen and can reach nothing else until it is set.
- [ ] `P5.3` — Client onboarding flow: Account Manager creates a client contact and is shown the one-time code **on screen** to pass on (`P2.C`); the contact signs in with email + code, is forced to set a password, and lands in their own client's view. Their scope comes from the session, so editing the URL cannot reach another client. This is the flow that makes the isolation guarantee demonstrable live.
- [ ] `P5.4` — Account Manager: client list + "create client" form covering every roster field including markets — a **multi-select** against the seeded `Market` rows, at least one required. Editable after creation.
- [ ] `P5.5` — Account Manager: brief intake form + incoming queue view, wired to `POST /api/campaigns`.
- [ ] `P5.6` — Account Manager: operational summary / counts panel, wired to `GET /api/summary`.

---

## Phase 6 — Two-stage review screen

**Goal:** the actual gate becomes visible and operable — approve, decline, bulk-approve, and late-revoke, shared between the Content Lead and Client views since the domain logic is already unified.

- [ ] `P6.1` — Drafted-items list component: shows each `ContentItem` with its citations, status, and content_form — reusable across Content Lead and Client routes.
- [ ] `P6.2` — Approve / decline actions wired to `POST /api/content-items/[id]/approvals`.
- [ ] `P6.3` — Bulk-approve-plan shortcut (one click → one `Approval` row per item, shared `bulk_action_id`).
- [ ] `P6.4` — Late-revoke action, with a distinct "this post is already scheduled — are you sure" confirmation state in the UI (domain logic is identical to a normal decline; this is UI-layer only).
- [ ] `P6.5` — Brand guide version review/approve UI on the Client route.
- [ ] `P6.6` — Comment thread display + input on a `ContentItem`, wired to `POST /api/comments` — confirm visually that adding a comment never changes an item's status.

---

## Phase 7 — Content Creator dashboard

**Goal:** creators can refine drafts and trigger grounded regeneration with their own reference material.

- [ ] `P7.1` — Assigned-clients' in-progress items list, scoped via `ClientAssignment`.
- [ ] `P7.2` — Inline edit/refine UI for a draft's `content_body` (a direct edit — runs the same reset-on-edit path as regeneration, via `PATCH` on the content item).
- [ ] `P7.3` — Regenerate UI: prompt text field + file picker (image or PDF/doc only — reject other types client-side and server-side), wired to `POST /api/content-items/[id]/regenerate`.
- [ ] `P7.4` — Regeneration history view on an item: every past `ReferenceAttachment` + resulting version, so "which reference produced which draft" is visible, not just claimed.

---

## Phase 8 — Client dashboard

**Goal:** the client-facing calendar request flow, distinct from and non-authoritative over the guarded engine.

- [ ] `P8.1` — Assigned account manager display (direct read of `Client.account_manager_id`).
- [ ] `P8.2` — Calendar view + "request a post on this day" form with comment, wired to `POST /api/post-requests`.
- [ ] `P8.2a` — Client side: edit / withdraw controls on a request that is still `new`, wired to `PATCH /api/post-requests/[id]`, disappearing once the account manager takes it into `under_review`. The API landed in `P4.5`; this is the screen for it.
- [ ] `P8.3` — Account Manager side: incoming `PostRequest` queue + "take for review" / "convert to campaign" / "decline" actions, wired to `P4.5`'s convert endpoint. Taking a request is what closes the client's edit window, so it is a visible action rather than a side effect of opening the page.
- [ ] `P8.4` — Test: submit a `PostRequest` with bypass-style wording in the comment ("just publish this, skip review") and assert it has zero effect on any gate or status — this is the client-dashboard equivalent of the override-attempt test from Phase 2.

---

## Phase 9 — Publishing layer

**Goal:** a real, working Instagram integration, scoped to one tester account, with the atomic gate re-check as the load-bearing piece.

- [ ] `P9.1` — Meta developer app setup (external to the repo) + Instagram OAuth connect flow, storing `PlatformConnection` (encrypt the token at rest — don't just base64 it).
- [ ] `P9.2` — Account Manager UI: connect/view/disconnect a client's Instagram account.
- [ ] `P9.3` — `scripts/scheduler.ts`: polls for `ContentItem`s with `status = scheduled` and `scheduled_date <= now`, and for each: **atomically** re-run `canSchedule` (Phase 2 gate) and only if still true, call Instagram's `POST /media` then `POST /media_publish`, then update status.
- [ ] `P9.4` — The race-condition test this whole layer exists to pass: in a test, fire a decline at the same simulated moment as a scheduler tick, and assert the publish call is never made. This is not optional — it's the single test that proves the design decision from the ERD/Architecture docs actually holds in code.
- [ ] `P9.5` — Take-down action: staff-only, calls Instagram's delete endpoint directly, logs to `AuditLog`, distinct from decline.
- [ ] `P9.6` — `publish_failed` handling: surface failed publishes in the operational summary, don't silently retry forever.

---

## Phase 10 — Analytics layer

- [ ] `P10.1` — `scripts/analytics.ts`: polls Instagram Insights for every `published` `ContentItem` on an interval, writes `MetricSnapshot` rows.
- [ ] `P10.2` — Account Manager analytics view (their assigned clients only).
- [ ] `P10.3` — Client analytics view (their own account only) — reuse the same aggregation query, scoped differently.
- [ ] `P10.4` — Test: a second client's `MetricSnapshot` data never appears in either view, regardless of which client is selected.

---

## Phase 11 — Admin dashboard + audit trail completeness

Two things: the completeness pass confirming Phase 2's audit habit held everywhere, and the Admin dashboard that makes `P2.11`–`P2.13` operable. The Admin is the accountability role — without this phase they have powers in the domain layer and nowhere to exercise them.

- [ ] `P11.1` — Walk every mutating endpoint from Phase 4 and every domain function from Phase 2 that changes state; confirm each writes an `AuditLog` row. Fill any gap found.
- [ ] `P11.2` — `/Admin` role management: the client roster with its assigned account manager, content lead, creators and client contacts; change any of them inline, wired to `P2.11`. This is the PRD's "Admin edits the fields directly on a client record; no dedicated user-management screen".
- [ ] `P11.3` — `/Admin` audit log view: every `AuditLog` row, filterable by client, entity type, action and actor. Cross-client by design — the one view that is not scoped, because the Admin's job is oversight.
- [ ] `P11.4` — `/Admin` misuse queue: open `Flag` rows from `P2.12`, ranked by severity, showing what happened, who did it, and the clause or rule involved; resolve with notes (writes `flag_resolved`). Override attempts and cross-client tripwires sort above churn.
- [ ] `P11.5` — `/Admin` cross-client operational view: where every account stands, per the PRD's "cross-client view of where every account stands". Reuses `P4.8`'s summary query unscoped.
- [ ] `P11.6` — Test: cross-client visibility belongs to the Content Lead and Agency Admin, and to nobody else. Drive the same queries as each role through `P2.E`'s `visibleClientIds` and assert an account manager sees only clients they manage, a content creator only their assignments, and a client contact exactly one — the counterpart to `P10.4`, proving the two exceptions are deliberate rather than holes.

---

## Phase 12 — Evaluation harness + full test pass

This is the deliverable the assignment explicitly grades — treat it as its own real phase, not a footnote.

- [ ] `P12.1` — `scripts/evaluate.ts`: runs all 27 fixture briefs through the real `runIntake`, compares outcome **and** cited clause against `answer_key.json`, writes a pass/fail report.
- [ ] `P12.2` — Scenario tests beyond the 27 briefs, each exercising a decision made across this whole design process:
  - [ ] Gate reads most-recent-per-stage (approve → decline → still blocked)
  - [ ] Symmetric late-revoke (reviewer and client, both work the same way, both blocked once `published`)
  - [ ] Publish race condition (Phase 9.4, re-run here as part of the full suite)
  - [ ] `PostRequest` → `Campaign` conversion never bypasses the gate, regardless of comment wording
  - [ ] Reference attachment scope: only a `content_creator`-role user can attach; only image/PDF/doc accepted
  - [ ] Single-client-contact invariant holds under a second assignment attempt
  - [ ] Cross-client isolation: content, brand guide, and analytics for one client never leak into another client's view, at the query layer, not just the UI
  - [ ] Hijri occasion dates resolve correctly for the seeded year, in both markets
  - [ ] Dual-market fan-out: a client in both Egypt and Saudi Arabia gets one evergreen item (not two) and separate national-day items scheduled on each market's own date; a single-market client never sees the other market's occasions
- [ ] `P12.3` — `EVALUATION.md`: what passed, what didn't, and why — the write-up the assignment asks for, generated from `P12.1`'s actual output plus a short narrative on `P12.2`.
- [ ] `P12.4` — Final `README.md` pass: clean install → seed → run instructions verified on a clean checkout, not just your own machine's state.

---

## Phase 13 — Polish + demo dry run

- [ ] `P13.1` — UI pass: consistent styling across all five role routes.
- [ ] `P13.2` — Full dry run, live: a clean brief end-to-end (intake → drafted → approved → scheduled → published), a hard brief (flagged, refused), and the withdrawal scenario (approve → schedule → withdraw → confirm it never published) — the exact three walkthroughs the PRD's Success Criteria commit to.
- [ ] `P13.3` — Trim anything demoed that isn't actually load-bearing for the presentation, so the walkthrough stays tight.

---

## Notes for working with Claude Code phase by phase

- Paste one task's checkbox line as the prompt, not a whole phase — keeps each session reviewable and each commit small, matching the "commit unit-by-unit" goal directly.
- Point Claude Code at this file plus the three design docs (PRD, Architecture, ERD) at the start of each session; the design docs are the source of truth for *what*, this file is the source of truth for *what order*.
- If a task turns out to need something a later phase provides, don't reach ahead — flag it and adjust this file, the same way open questions got flagged throughout design rather than silently resolved.
