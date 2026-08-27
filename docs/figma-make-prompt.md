# Figma Make prompt — Skip Studio

Paste everything below the line into Figma Make.

---

Design the UI for **Skip Studio**, an AI-powered content operations platform for a marketing agency.

It runs content production end to end for a roster of client brands: campaign intake, AI-drafted content grounded in each client's own brand rules, two-stage approval, occasion-aware scheduling, publishing to Instagram, and performance analytics. Five roles share one app, each seeing only what their role owns.

**You own the UX.** Everything below is what the product *is* and what the brand *looks like* — the information architecture, navigation patterns, layout, hierarchy, spacing, interaction and component design are yours to decide. Use your judgment for what serves this product best. The one thing not open for reinterpretation is the brand palette and type, specified below.

## Brand — use these exact values

**Colors**

| Token | Hex |
|---|---|
| Amber (brand) | `#F9B42D` |
| Amber dark (hover) | `#E5A11C` |
| Ink | `#222222` |
| Heading text | `#0F172A` |
| Body text | `#364151` |
| Surface | `#FFFFFF` |
| Canvas | `#F7F8FA` |
| Border | `#D1DAE5` |
| Tint (selected/highlighted) | `#E7F6FF` |

**Status colors** — each is a text color and a pale background, always used as a pair:

| Meaning | Text | Background |
|---|---|---|
| Flag — needs attention | `#C2410C` | `#FFEDD5` |
| Danger — refused, failed | `#B91C1C` | `#FEE2E2` |
| OK — approved, published | `#15803D` | `#DCFCE7` |
| Info — in progress, waiting | `#0369A1` | `#E0F2FE` |

One constraint that matters: **amber is brand chrome, not a warning.** It carries the identity — primary actions, active states. It must never signal "attention", or a flagged item sitting under amber chrome stops standing out. Anything meaning attention uses the flag orange-red.

Light theme only. No dark mode.

**Type**
- Headings — **Rubik**
- Body — **Karla**
- Buttons and navigation labels — **Baloo Bhaijaan 2**

**Shape** — the brand uses fully pilled buttons (30px radius). Everything else is yours.

## What the product does

A marketing agency produces content for many client brands across Egypt and Saudi Arabia. Every client has their own brand guide — voice, audience, things to do, things never to do. On top of that sits an agency-wide compliance handbook. The platform's core promise is that **nothing gets drafted that breaks a rule, and every draft cites the specific rule it was written under** — and that **nothing publishes without both an internal approval and a client approval currently on record.**

The work moves like this: a brief comes in (submitted by an account manager, or converted from a client's own request), the engine looks up that client's rules and the upcoming regional occasions for their market, and drafts a multi-form content plan. A creator refines it. An internal reviewer approves. The client gives final sign-off. Only then is it scheduled, and only then published — with both approvals re-confirmed at the moment of publishing. Either party can withdraw an approval late, right up until a post goes live.

## The five roles and what each needs

**Account Manager** — owns a set of client accounts. Creates clients and their contacts, assigns the team, submits briefs, handles incoming client requests, manages the calendar, connects Instagram, and is the internal reviewer by default. Needs visibility into where every one of their clients' work stands.

**Content Lead** — prompts the engine like a creator does, then hands what comes out to the right creator. Reviews across all clients. Needs the conversation surface, a way to dispatch work, and review tools.

**Content Creator** — originates content in an ongoing conversation with the engine, scoped to one client. Refines drafts, regenerates individual pieces with their own reference material, and submits work for approval. Needs their assigned clients' in-progress work, and the rules readable *before* they write, not just cited afterward.

**Client** — approves or declines their own content and changes to their brand guide. Requests posts on a calendar, comments, sees their own analytics and who their account manager is. Sees only their own account, nothing else.

**Agency Admin** — oversight only: a misuse queue, the audit trail, and who is assigned where. Holds no drafting or approval power.

Cross-client visibility is deliberate and narrow: only the Admin and the Content Lead see across accounts. Everyone else is scoped.

## Screens to cover

**Shared** — sign in; a persistent role-aware navigation; a review surface used by three different roles (an item, its citations, approve/decline, a comment thread, bulk selection, and a confirmation for withdrawing an approval already given).

**Account Manager** — overview dashboard; client roster and client detail; new-client creation; brief intake; brief queue; incoming client requests; a scheduling calendar; analytics.

**Content Lead** — overview; the chat surface; review; assigning an item to a creator.

**Content Creator** — overview; the chat surface (the most important screen — see below); assignments; a standing reference for the agency standards.

**Client** — overview; approvals; requests with a calendar and a submission dialog; brand guide versions to approve; analytics.

**Agency Admin** — overview; the misuse flag queue with resolution; role assignment; a filterable audit trail.

## The chat surface

This is where creators do most of their work, so it deserves the most design attention.

A creator holds an ongoing conversation with the engine, scoped to one client. Three things happen in it that the design has to carry:

1. **The engine asks rather than guesses.** If the conversation hasn't yet said enough to work from, it asks for the missing piece instead of inventing one.
2. **The creator chooses what gets drafted.** When the thread says enough, the engine *proposes* a set of possible items — each with its form, platform, a short summary, and the specific brand-guide clauses it would be written under. Nothing is generated until the creator picks. Unticked items are never drafted at all. This choice is the point of the screen and should feel like one.
3. **A refusal is a normal outcome, not an error.** A prompt unrelated to that client's content is declined and recorded. It belongs in the conversation as the engine's answer — not as a red error state.

The client's own brand guide belongs on this screen, surfacing once a client is chosen — before that there is no such thing as "the brand guide" to show. It should be available without dominating the screen; a creator arrives to write, not to read.

Once items are drafted they appear with their status, the clauses they cite, a thumbnail where the piece is visual, and a way to submit individual ones for approval. Image generation is allowed to fail without failing the campaign, so "no image yet" is a real state to design for.

## Domain vocabulary — use these exact labels

**Content statuses**: Drafted · In refinement · With the reviewer · Internal approved · Pending client review · Client approved · Scheduled · Declined · Flagged · Publishing · Published · Publish failed

**Content forms**: post · image · video · reel · photoshoot · email · blog post · ad copy · hashtag set · CTA · creative prompt

**Misuse flags**, with severity: approval override attempt (high) · cross-client data (high) · role boundary violation (high) · off-task generation (medium) · approval churn (low)

## Two kinds of rule

The split matters, and the design should carry it. The **agency standards** are one handbook governing every client — the same text whoever is writing, and unchanging per task, so they belong wherever a creator can consult them at any time. A **client's brand guide** only means something once you know which client you are writing for, so it belongs where that has been decided: the chat surface, against the chosen client. A single page listing every assigned client's guide at once asks the reader to first find the right client — a question the task has usually already answered.

## Product principles the design must respect

- **Every flag explains itself in plain language.** Never show a bare rule code like "CR.4" as the whole message. Lead with what happened, then cite the rule — *"Cairo Roast's brand guide does not allow this, so it was not drafted. (Clause CR.4 — Never discount.)"* A reader who leads with a code has to go look it up before the sentence means anything.
- **Consequences are shown before the action, not after.** Anything that costs an approval already given, or that gets recorded for the Admin, says so *while the user is deciding* — not once it's done.
- **Empty states are sentences, not blank panels.** Say what would appear here and how to make it happen.
- **The reasoning is visible.** Every drafted item shows the rules it was written under. That traceability is the product's core value and shouldn't be buried.
- **Content appearing must not break the layout.** These screens grow as work is produced — a conversation that generates eight items, a roster of two hundred clients. Design for growth, not just the empty case.

This is a dense, professional B2B tool used all day by people who know their domain. Favor clarity and information density over decoration.
