# Product Requirements Document

## AI-Powered Content Operations Platform — Skip Studio

| | |
|---|---|
| **Prepared for** | Skip Studio (fictional client — Exology Pioneer Program, Week 4 Final Project) |
| **Prepared by** | Amr Hassan Safieddine Nagy |
| **Date** | August 24, 2026 |
| **Status** | Draft — for review |

---

## 1. Overview

### What is this, in one paragraph?

A web-based system that runs Skip Studio's content production and publishing for every client in one place: an account manager creates and manages client accounts — including the market each one operates in — and submits a campaign brief, or converts a client's own calendar request into one. The system looks up that client's rules, resolves the upcoming regional and local occasions relevant to their market, and drafts a full multi-form content plan — posts, images, videos, reels, and photoshoot briefs — in their voice. An assigned creator refines any draft, and can prompt the engine to regenerate a specific piece using their own reference material. An internal reviewer approves it, the client gives final sign-off, and only then is anything scheduled — and only then does the system publish it to the client's connected Instagram account, re-confirming both approvals are still in place at that exact moment. Either the reviewer or the client can withdraw an approval they already gave, even after a post is scheduled, right up until it goes live. Once a post is published, its performance data flows back to the account manager and the client. Every decision the system makes points to the specific rule it worked from, and nothing bypasses either approval step regardless of what a brief or a client comment asks for.

### Why are we building it?

Every campaign today is planned, written, scheduled, and published by hand, across a patchwork of tools with no shared record — collecting the brief, checking it against the right client's brand guide from memory, drafting, chasing internal and client sign-off, posting to Instagram manually, and pulling performance numbers separately if anyone gets to it at all. Quality varies by who's writing, keeping many clients' voices straight is hard, nothing structurally enforces that both approvals actually happened before something goes live, and growth is capped by headcount rather than demand. If nothing changes, taking on another client means hiring, not just onboarding — and every additional live account is one more manual point where a mistake can reach the public before anyone catches it.

---

## 2. Users

### Who is this for?

| User type | Description | What they need from this product |
|---|---|---|
| **Account Manager** | Owns the client relationship for a set of assigned clients; creates new client accounts, including the market they operate in; submits campaign briefs on their behalf or converts a client's calendar request into one; connects and manages each client's Instagram account. | A reliable way to get a client's content drafted, approved, and published correctly the first time, and visibility into where every one of their clients' work and performance stands. |
| **Content Creator** | Refines the engine's draft — captions, scripts, images, video, reel and photoshoot briefs — before internal review; can prompt the engine to regenerate a specific piece using a reference image or document of their own; a client's team can have one or more. | Clear access to just their assigned clients' in-progress work, an easy way to edit a draft, and a way to guide a regeneration with their own reference material. |
| **Content Lead** | When assigned in place of the account manager, acts as a client's internal reviewer — including pulling back an approval they already gave if something needs a second look. | The ability to approve, edit, reject, or reverse an earlier approval on a post, with the reasoning behind each drafted item visible. |
| **Client** | Gives final approval on content and on changes to their own brand guide; requests or reschedules posts on their own calendar with comments; can withdraw an approval already given, even after a post is scheduled, up until it publishes; sees their assigned account manager and their own performance data. | Visibility into only their own reviewed content, guide, and performance, and a simple way to approve, decline, or ask for a post on a specific day. |
| **Agency Admin** | Assigns each client's account manager, reviewer, and creators; not involved in day-to-day content work. | A cross-client view of where every account stands, and control over who's assigned where. |

**Primary user:** There isn't a single tiebreaker — completing a campaign genuinely needs all five roles. If one had to anchor the design, it's the Account Manager: every client and every campaign starts with them, and the whole point of the system is to let one person reliably run more client accounts, end to end through publishing, than the manual process allowed.

> Note: "Internal Reviewer" is not a sixth role — it's a capability held by the account manager by default, or reassigned to a content lead per client.

---

## 3. What This Product Does (In Scope)

- **Client management** — an account manager can create a new client directly in the product, with every field the roster tracks, including which market the client operates in (Saudi Arabia, for this version). Admin can reassign a client's account manager, reviewer, and creators after the fact.
- **Campaign intake** — the account manager submits a brief through a form, picks one from an incoming queue, or converts a client's own calendar request into one; the system reads out the client, objective, audience, channels, and requested deliverables. Every post produced from that brief stays linked to it.
- **Guarded content engine** — for every brief, the system looks up the client on the roster, resolves the occasions relevant to their market for the campaign's planning window, retrieves the rules that specifically govern them, and drafts the full multi-form content plan — posts, image briefs, video scripts, reel concepts, and photoshoot briefs — in their voice. Every brief reaches one of four outcomes: drafted and queued, sent back for missing information, flagged with the rule it breaks, or — if it tries to bypass approval — drafted but refused for scheduling and flagged to a human. A brief for a client that isn't on the roster, or one marked inactive, is flagged the same way.
- **Occasion calendar** — the system maintains a calendar of regional and local occasions for the client's market — public holidays, religious observances, retail moments — and surfaces the ones relevant to a campaign so content can be planned and scheduled around them. Dates that move year to year on the Hijri calendar (Ramadan, Eid al-Fitr, Eid al-Adha) are resolved correctly for the current calendar year.
- **Flag resolution** — when a brief is flagged, only the specific issue needs fixing; the account manager revises and re-runs it without restarting the rest of the campaign. A brief goes back to intake entirely only when it was incomplete in the first place.
- **Grounded, cited output** — every drafted item states which rule it was written under, so a reviewer can see why, not just what. The same kind of request can land differently for different clients, because the engine always grounds in that specific client's guide, never a generic pattern. Where a creator supplies their own reference material to guide a draft, that material shapes the creative direction but never overrides a rule — a reference image or document can't make an otherwise-disallowed claim or approach draftable.
- **Creator refinement** — once drafted, any of a client's assigned creators can refine a post before it goes to internal review, or prompt the engine to regenerate a specific piece directly — optionally attaching a reference image or a PDF/document with instructions. A regenerated piece is checked against the client's rules the same as any other draft; if the piece had already been approved, that approval is cleared and both review stages run again.
- **Two-stage review, reversible** — every post moves through internal review, then client approval, in that order. Either the internal reviewer or the client can also withdraw an approval they already gave — even after a post is scheduled — right up until it actually publishes; withdrawing sends the post back through both stages again, the same as a decline the first time around.
- **Scheduling and publishing** — once both approvals are currently in place, a post is scheduled. At the scheduled time, the system re-confirms both approvals are still in place — not just that they were, when it was first scheduled — and only then publishes to the client's connected Instagram account.
- **Performance analytics** — once a post is live, the system pulls its performance numbers on a regular schedule and shows them to the account manager, for their own clients, and to the client, for their own account.
- **Client dashboard** — a client can see which account manager is assigned to them, request or ask to reschedule a post on a calendar for a specific day, and leave a comment on that request or on any of their existing posts. A request is a starting point for a real campaign, not a shortcut around one — an account manager still has to convert it into a brief that goes through the same guarded engine and the same two approvals as anything else.

---

## 4. What This Product Does Not Do (Out of Scope)

- Publishing to any social platform other than Instagram
- Reference material in any form other than an image or a PDF/document, for guiding content generation — no video references. Video as a generated deliverable itself is in scope.
- A live trends feed pulled from any external platform — trend input is agency-curated, not sourced automatically
- More than one market, or any sub-national region within a market — Saudi Arabia only, for this version
- User invite flows or general account administration, beyond Admin assigning a client's team
- Automated reminders or notifications

---

## 5. Success Criteria — What "Done" Means

- [ ] A brief moves, live, from intake through a clean draft to a fully approved, scheduled, and published plan.
- [ ] A brief that's incomplete is met with a request for the missing information, not a guess.
- [ ] A brief that's off-brand or non-compliant is never drafted — it's flagged with the specific rule it breaks.
- [ ] A brief for an unknown or inactive client is flagged, not drafted.
- [ ] The same kind of request is drafted for one client and flagged for another when their brand guides disagree — proof the engine grounds in that specific client's rules, not a generic pattern.
- [ ] A brief that tries to skip or fake an approval still produces no scheduled or published content, and the attempt itself is flagged.
- [ ] Sensitive-sector clients are always marked for mandatory client compliance review, even on an otherwise clean brief.
- [ ] An approval — internal or client — can be withdrawn after the fact, even once a post is scheduled, and the post correctly returns to draft and must clear both stages again.
- [ ] A post is never published without both approvals currently in place at the moment of publishing, not just at the moment it was scheduled.
- [ ] A content plan includes every requested form — captions, images, videos, reels, and photoshoot briefs — not just text.
- [ ] Content scheduling correctly reflects upcoming occasions for the client's market, including Hijri-calendar dates for the current year.
- [ ] A client's calendar request becomes a real campaign only once an account manager converts it, and never bypasses either approval stage.
- [ ] Performance data for a published post is visible to its account manager and its client, and to no one else.
- [ ] A creator's reference material shapes a draft's direction but never overrides a compliance rule.

**This is considered complete when:** a real brief can be walked end-to-end — intake, guarded drafting, creator refinement, internal review, client approval, scheduling, and publishing — entirely inside the system, alongside a second, harder brief (off-brand, non-compliant, or an approval-bypass attempt) that the system correctly refuses to draft or schedule, and a third walkthrough showing an approval withdrawn after a post is already scheduled, correctly pulling it back before it publishes.

---

## 6. Assumptions & Constraints

- [ ] The rule behind every decision — drafted, flagged, or held for extra review — is visible to a human reviewer.
- [ ] Editing a client's brand guide changes what the engine produces for them, once the client approves the new version; past versions remain visible.
- [ ] No client's content, drafts, brand guide, or performance data is ever visible to another client's team or an unassigned staff member.
- [ ] Any change to an already-approved post — an edit, a schedule-date change, or a withdrawn approval, from either the reviewer or the client — resets it to draft and requires both stages to clear again. One rule, applied the same way regardless of cause.
- [ ] A withdrawn approval stops being possible once a post is actually publishing or has published; a live post can only be removed through a separate, staff-only action, never a retroactive decline.
- [ ] Nothing is ever marked scheduled or published without both internal and client approval currently recorded, re-checked at the moment of publishing — including when a post's intended time has already passed.
- [ ] The operational summary correctly reflects every client's pipeline by status, market, and upcoming occasion at any point in the walkthrough.
- [ ] The system's decisions on a representative set of real briefs match the correct outcome and the correct reasoning, not just a plausible-looking result.

- **Reviewer default** — assumed the account manager is a client's reviewer unless Admin assigns a content lead instead.
- **Approval granularity** — each post carries its own approval by default; approving a whole plan in one action is an available shortcut, not a different underlying record.
- **Brand guide governance** — fully editable in-app by the account manager, with version history, gated behind client approval before a new version takes effect.
- **Decline comments** — a required free-text field rather than structured reason codes, since a human reads it either way.
- **Role assignment** — kept intentionally light: Admin edits the account manager/reviewer/creator fields directly on a client record; no dedicated user-management screen.
- **Market** — a real, expandable record rather than a hardcoded value; Saudi Arabia is the only one seeded for this version, so a second market later is a data addition, not a redesign. No sub-national region is tracked.
- **Roster tier** — informational only; nothing in the product's behavior, queueing, or review path depends on it.
- **Content granularity** — one brief produces a separate content record per deliverable and per form (a caption, an image brief, a reel concept are each their own item), not one piece adapted across channels — so each carries its own status and approval independently.
- **Multiple creators on one draft** — no checkout or locking; the latest edit wins, and every edit is kept in the revision history so nothing is silently lost.
- **Trends** — agency-curated, attached by staff to a brief; not pulled from a live external feed.
- **Photoshoots** — treated as a planning artifact (a shot list and schedule slot), not an AI-generated asset; the resulting real-world footage is uploaded afterward like any other asset.
- **Instagram connection, this version** — built and tested against one Professional (Business or Creator) account added as a developer-mode tester, since Instagram's personal accounts have no API access at all, Professional accounts cannot be private, and full production access to arbitrary client accounts requires a multi-week platform review that doesn't fit this build. The integration itself is real; its reach for this version is intentionally narrow.
- **A client comment is not a decision** — a comment on a request or a post never withdraws an approval or changes its status by itself; only a formal approve/decline action, or a deliberate edit, does that.
- **Reference attachments** — a content creator only, at the moment of prompting a generation or regeneration; scoped to one piece of content; image or PDF/document only.
- **Analytics access** — the account manager (their own clients) and the client (their own account) only, for this version; not extended to content creators.
- **Missed schedule deadlines** — a post whose intended time passes without both approvals never becomes scheduled; it stays visible as awaiting approval rather than auto-publishing or silently expiring.
- **Reminders** — out of scope for this version; the operational summary is the source of truth for what's waiting.
- **Approval channel** — the product's own review screen is the only channel for internal and client decisions; no email or messaging-app integration.

---

## 7. Open Questions

The three open questions from the original scope have been resolved through design: roster tier is informational only (§6); content is modeled per deliverable, not adapted across channels (§6); multiple creators share a draft without checkout, relying on revision history (§6). One question remains from the features added since:

| Question | Who needs to answer it | Needed by |
|---|---|---|
| Can a client edit or withdraw a calendar request before the account manager reviews it, or is it a one-shot submission once sent? | You (project owner) | Before finalizing the client dashboard's request screen |

---

## A. Appendix · Traceability

*Beyond the template, kept for design defense.*

| Section above | Traces to |
|---|---|
| §3 Client management | Client answer — account manager creates clients directly, including market |
| §3 Campaign intake | Assignment: "Take campaigns in through an intake"; client answer — also accepts a converted calendar request |
| §3 Guarded content engine | Assignment: "Produce every campaign through the guarded engine"; agency standards Clause 0.6; answer key decision taxonomy; client answer — multi-form output |
| §3 Occasion calendar | Client answer — regional/local occasion calendar, scoped to market, Hijri-aware |
| §3 Flag resolution | Client answer — fix and re-run just the flagged item; whole brief only restarts if incomplete |
| §3 Grounded, cited output | Assignment: "Ground every piece in the client's guide and the agency rules"; agency standards Clauses 0.4, 0.7; client answer — reference material carries no authority |
| §3 Creator refinement | Client answer — content creator role; regeneration with creator-supplied reference material |
| §3 Two-stage review, reversible | Agency standards Clauses 0.1–0.3; client answer — either party can withdraw an approval after the fact, through scheduled |
| §3 Scheduling and publishing | Client answer — real Instagram publishing, gate re-checked at the moment of publishing |
| §3 Performance analytics | Client answer — account manager and client access to published-post performance |
| §3 Client dashboard | Client answer — assigned account manager visible; calendar request with comments; no authority over the gate |
| §4 Out of scope | Client answers narrowing platform, reference type, trends source, and market to what's actually being built this version |
| §6 Assumptions & Constraints | Client answers marked "your design" / "your call" across the Q&A rounds, plus resolutions of the original open questions |
| §7 Open Questions | Residual gap — not yet resolved |
