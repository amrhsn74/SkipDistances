# Claude prompt — Skip Studio presentation

Paste everything below the line into Claude.

---

Build me a presentation that walks an audience through **Skip Studio** and the AI-powered content operations platform built for it. Publish it as an artifact.

## Before you start

Read these four documents in the repo — they are the source of truth, and everything in the deck should trace back to them:

- `docs/PRD.md` — what the product is, who it's for, scope, and the four intake outcomes
- `docs/architecture.md` — the guarded engine, the approval gate, publishing, analytics, governance
- `docs/data-schema-erd.md` — all 25 entities and the two relationship diagrams
- `docs/project-plan.md` — how it was built, phase by phase

Also read `data/guidelines/00_agency_standards.md` and one brand guide (say `11_brand_cairoroast.md`) so the rule examples in the deck are real clauses, not invented ones.

## Audience and framing

prepared by Amr Hassan Safieddine Nagy. The audience is technical reviewers who have not seen the codebase. They need to understand what was built, why the design decisions were made, and see that the guarantees are real rather than claimed.

Skip Studio is a **fictional client** — a marketing agency running content for many real-world-style brands. Present it as the business context the platform was built for, not as a real company. Do not invent a founding date, headcount, revenue, or executive team. If the deck needs a "who is Skip Studio" section, build it from what the PRD actually establishes: an agency running content production and publishing for a roster of clients across Egypt and Saudi Arabia, currently doing it by hand across a patchwork of tools with no shared record.

## Structure

Roughly 18–24 slides, in five acts.

### Act 1 — The agency and the problem (3–4 slides)

- Who Skip Studio is and what it does: content production for a multi-client roster, across two markets.
- The services the platform covers end to end: campaign intake, multi-form content drafting, two-stage approval, occasion-aware scheduling, Instagram publishing, performance analytics, and a client-facing request dashboard.
- The problem, stated concretely from the PRD: every campaign planned, written, scheduled and published by hand; brand guides checked from memory; nothing structurally enforcing that both approvals happened; growth capped by headcount. Land the consequence — taking on another client means hiring, and every live account is one more place a mistake reaches the public.

### Act 2 — The two guarantees (2–3 slides)

This is the spine of the whole deck. Introduce the two promises early, then show the rest of the system upholding them:

1. **Nothing is scheduled or published without both internal and client approval currently recorded.**
2. **Nothing is drafted that breaks a rule — every draft cites the clause it was written under.**

Make the key point explicitly: both are enforced in **application code, never in a prompt**. Retrieval and rule-checking are deterministic; only extraction and drafting are model calls. Show a concrete example — the same request landing differently for two clients because each is grounded in their own guide.

### Act 3 — The five roles (3–4 slides)

Account Manager, Content Lead, Content Creator, Client, Agency Admin. For each: what they own, what they see, and what they cannot do.

Bring out the design decisions that are easy to miss:

- "Internal Reviewer" is **not** a sixth role — it's a capability the account manager holds by default, reassignable to a content lead per client.
- Cross-client visibility is granted to exactly two roles on purpose: Admin (oversight is the job) and Content Lead (they review across accounts). Everyone else is scoped.
- The Agency Admin holds oversight but **no drafting or approval power**.

A visibility matrix — role against what they see — works well here.

### Act 4 — The workflow (5–7 slides)

Walk one campaign from brief to published post, then cover the branches.

- **The guarded engine pipeline**, in order: analyze brief → look up client → check required fields → resolve calendar → search guidelines → generate plan → queue or flag. Show which steps are deterministic code and which are model calls.
- **The four intake outcomes**: drafted and queued; sent back for missing information (Clause 0.5); flagged with the rule it breaks (Clause 0.6 for unknown or inactive clients); or drafted-but-refused-for-scheduling when a brief tries to bypass approval (Clause 0.3). Make the last one precise — an override attempt is *recorded, never obeyed, and never a reason to refuse the work*.
- **Chat-led creation**: a creator works in a conversation scoped to one client. The engine proposes a plan and the creator picks what gets drafted — unchosen items are never generated, judged, or stored. Where the thread hasn't said enough, the engine asks rather than guessing. A prompt that isn't about that client's content is refused and raised to the Admin, judged against the whole thread rather than the single turn.
- **The approval gate**, as a state machine: drafted → pending internal → internal approved → pending client → client approved → scheduled → publishing → published. Emphasize that either party can withdraw an approval **late**, even after scheduling, right up until publish — and that any invalidation (late decline, content edit, date change) produces the identical reset to `drafted`. One rule, no per-cause branching.
- **Publishing**: the gate is re-checked **atomically** at the scheduled moment, not assumed from when it was scheduled. A decline landing a second before cannot lose the race.
- **Governance**: the five misuse flag types with their severities. Explain the recent refinement — a guideline violation caught at drafting no longer stores a flag for the Admin, because a refusal a creator reads and abandons is not evidence. The row is raised only if the creator submits the item anyway. Misuse flags still fire on sight, because there the act is the evidence.

### Act 5 — The data model (3–4 slides)

Don't dump all 25 entities on one slide. Group them the way the ERD does, and give each group a slide or a section:

- **People & access** — User, LoginOtp, Session, ClientAssignment
- **Clients & markets** — Client, Market, ClientMarket
- **Brand governance** — BrandGuideVersion, GuidelineClause
- **Calendar** — Occasion, OccasionDate
- **Campaigns & content** — Campaign, ContentItem, ContentItemCitation, MediaAsset, ReferenceAttachment
- **Review & compliance** — Approval, Flag, Conversation, ConversationTurn, AuditLog
- **Publishing & performance** — PlatformConnection, MetricSnapshot
- **Client requests** — PostRequest, Comment

Render the relationships as **Mermaid `erDiagram` blocks** — artifacts render Mermaid natively from `<pre class="mermaid">`. Reuse the two diagrams in `docs/data-schema-erd.md` rather than inventing new ones, but simplify each to the entities that slide is about; a full 25-entity diagram is unreadable projected.

Close on **traceability**, which is what the schema is really for: every scheduled item traces back to the brief it came from, the client and market it belongs to, the brand guide version it was grounded in, the clause it cited, and the approval history that cleared it.

## Design

Use the product's own palette so the deck and the app look like one thing:

- Amber `#F9B42D` (primary/accent), amber dark `#E5A11C`, Ink `#222222` (dark backgrounds)
- Heading `#0F172A`, body `#364151`, surface `#FFFFFF`, canvas `#F7F8FA`, border `#D1DAE5`
- Status colors — flag `#C2410C` on `#FFEDD5`, danger `#B91C1C` on `#FEE2E2`, ok `#15803D` on `#DCFCE7`, info `#0369A1` on `#E0F2FE`

Amber is **brand chrome, not a warning** — a flagged item must never be amber, or it stops standing out. Use the flag orange-red for anything that means "attention".

Fonts: Rubik for headings, Karla for body (both on Google Fonts, which artifacts can load). Give every face a real fallback stack.

Make it a **navigable slide deck** — arrow keys and click, one slide per view, with a slide counter and a contents slide. Not a scrolling document. It should be legible projected: large type, high contrast, one idea per slide, diagrams that survive being seen from the back of a room.

## What matters most

Prefer the *why* over the *what*. A reviewer can read a feature list; what they can't get anywhere else is the reasoning — why the rules live in code and not in a prompt, why cross-client retrieval is structurally impossible rather than merely forbidden, why a declined item resets to `drafted` instead of bouncing back into the reviewer's queue, why the off-task check only ever *allows* on the cheap deterministic pass.

Every claim in the deck should be one you can point at a document or a file for. If something in the docs is ambiguous, say so on the slide rather than smoothing it over.
