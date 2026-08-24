# Skip Studio — Content Operations · Data

Everything the product works from. Plain files, no database.

## `guidelines/`  — the knowledge the product grounds in (RAG corpus)
The agency standards handbook (pipeline & approval gate, compliance rules, platform
conventions — 20 numbered clauses) plus eight per-client brand guides (~40 brand rules:
voice, audience, dos and don'ts, restricted topics). Deliberately too long to paste in one
go, with tricky pairs — discounts are core for Layla Fashion but forbidden for Cairo Roast;
"organic" only for certified lines; superlatives only with substantiation; healthcare and
finance always get client compliance review — so the product must retrieve the right rule
for the right client, not guess.

## `clients.json`  — the roster (150 records)
Each record: client_id, name, industry, status (active/inactive), tier, channels, which
brand-guide file governs them, and the account manager. `lookup_client` reads from here;
no content is produced for unknown or inactive clients.

## `briefs/`  — the campaign briefs (27)
Each brief as plain text (id, client, title, objective, audience, channels, deliverables,
notes). The product's input; they seed the test set. The set spans every hero client and
each decision the product must make: draft-and-queue, request missing info, flag a brand or
compliance violation (with the rule it breaks), and refuse an attempt to bypass the
approval gate.

## `answer_key.json`  — ground truth (instructor copy)
For each brief: the expected decision, the violated or key rule, the tools a correct
product would use, and the rationale.

Decisions: **DRAFT** (complete, compliant → generate the plan and queue it for internal
review) · **REQUEST_INFO** (required fields missing or a claim needs substantiation) ·
**FLAG** (conflicts with the client's brand guide, the compliance rules, or the roster) ·
**REFUSE_OVERRIDE** (the brief tries to skip approvals or fake them — refused and flagged).
