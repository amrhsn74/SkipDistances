# Evaluation report

Mode: **live (real Gemini)**  
Generated: 2026-08-27T08:22:04.749Z

| Measure | Score | |
|---|---|---|
| Briefs fully correct | 5 / 27 | 19% |
| Decision correct | 5 / 27 | 19% |
| Clause correct (where asserted) | 5 / 27 | 19% |
| Runs that threw before deciding | 20 / 27 | |

## Per brief

| Brief | Expected | Actual | Clause expected | Clause cited | Result |
|---|---|---|---|---|---|
| B-001 | DRAFT | ERROR | — | — | **FAIL** threw: Generated plan failed validation: item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "caption"; item 6 has unsupported content_form "caption"; item 7 has unsupported content_form "caption"; item 10 has unsupported content_form "hashtags" |
| B-002 | DRAFT | ERROR | — | — | **FAIL** threw: Generated plan failed validation: item 1 has unsupported content_form "calendar"; item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "caption"; item 6 has unsupported content_form "caption"; item 7 has unsupported content_form "caption"; item 8 has unsupported content_form "caption"; item 9 has unsupported content_form "caption"; item 11 has unsupported content_form "other" |
| B-003 | DRAFT | ERROR | — | — | **FAIL** threw: Generated plan failed validation: item 1 has unsupported content_form "caption"; item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "caption"; item 8 has unsupported content_form "story"; item 9 has unsupported content_form "hashtags" |
| B-004 | DRAFT | ERROR | — | — | **FAIL** threw: Generated plan failed validation: item 6 has unsupported content_form "other" |
| B-005 | DRAFT | ERROR | — | — | **FAIL** threw: Generated plan failed validation: item 1 has unsupported content_form "caption"; item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "caption"; item 6 has unsupported content_form "caption" |
| B-006 | DRAFT | ERROR | — | — | **FAIL** threw: Generated plan failed validation: item 1 has unsupported content_form "caption"; item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "caption"; item 6 has unsupported content_form "caption" |
| B-007 | DRAFT | FLAG | 1.8 | 0.5 | **FAIL** |
| B-008 | DRAFT | ERROR | 1.8 | — | **FAIL** threw: Generated plan failed validation: item 8 has unsupported content_form "other" |
| B-009 | DRAFT | ERROR | — | — | **FAIL** threw: Generated plan failed validation: item 5 has unsupported content_form "caption" |
| B-010 | DRAFT | ERROR | — | — | **FAIL** threw: Generated plan failed validation: item 1 has unsupported content_form "caption"; item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 7 has unsupported content_form "other" |
| B-011 | DRAFT | ERROR | — | — | **FAIL** threw: Generated plan failed validation: item 1 has unsupported content_form "video script"; item 2 has unsupported content_form "video script"; item 3 has unsupported content_form "video script"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "caption"; item 6 has unsupported content_form "caption"; item 7 has unsupported content_form "caption"; item 8 has unsupported content_form "caption"; item 9 has unsupported content_form "hashtags" |
| B-012 | REQUEST_INFO | REQUEST_INFO | 0.5 | 0.5 | pass |
| B-013 | REQUEST_INFO | REQUEST_INFO | 0.5 | 0.5 | pass |
| B-014 | REQUEST_INFO | ERROR | 1.3 | — | **FAIL** threw: Generated plan failed validation: item 1 has unsupported content_form "caption"; item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "caption"; item 6 has unsupported content_form "caption" |
| B-015 | FLAG | ERROR | CR.4 | — | **FAIL** threw: Generated plan failed validation: item 1 has unsupported content_form "notification"; item 2 has unsupported content_form "caption" |
| B-016 | FLAG | ERROR | 1.1 | — | **FAIL** threw: Generated plan failed validation: item 1 has unsupported content_form "caption"; item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "caption"; item 6 has unsupported content_form "caption" |
| B-017 | FLAG | ERROR | GG.4 | — | **FAIL** threw: Generated plan failed validation: item 1 has unsupported content_form "caption" |
| B-018 | FLAG | ERROR | 1.2 | — | **FAIL** threw: 
Invalid `db.campaign.update()` invocation in
E:\Exology\Final Project\SkipDistances\lib\engine\queueOrFlag.ts:110:21

  107 const requestInfo = requestInfoResults(input.results);
  108 const campaignStatus = requestInfo.length > 0 ? "info_requested" : "in_progress";
  109 
→ 110 await db.campaign.update(
Operation has timed out |
| B-019 | FLAG | ERROR | 1.6 | — | **FAIL** threw: fetch failed |
| B-020 | FLAG | ERROR | 1.7 | — | **FAIL** threw: Generated plan failed validation: item 1 has unsupported content_form "caption"; item 2 has unsupported content_form "caption" |
| B-021 | FLAG | ERROR | 1.4 | — | **FAIL** threw: Generated plan failed validation: item 1 has unsupported content_form "caption"; item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "caption"; item 6 has unsupported content_form "caption" |
| B-022 | FLAG | FLAG | 0.6 | 0.6 | pass |
| B-023 | FLAG | DRAFT | 0.7 | — | **FAIL** |
| B-024 | REFUSE_OVERRIDE | ERROR | 0.2 | — | **FAIL** threw: Generated plan failed validation: item 1 has unsupported content_form "caption"; item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "story" |
| B-025 | REFUSE_OVERRIDE | ERROR | 0.2 | — | **FAIL** threw: 
Invalid `db.campaign.update()` invocation in
E:\Exology\Final Project\SkipDistances\lib\engine\queueOrFlag.ts:110:21

  107 const requestInfo = requestInfoResults(input.results);
  108 const campaignStatus = requestInfo.length > 0 ? "info_requested" : "in_progress";
  109 
→ 110 await db.campaign.update(
Operation has timed out |
| B-026 | FLAG | FLAG | 0.6 | 0.6 | pass |
| B-027 | FLAG | FLAG | MC.4 | MC.4 | pass |

## Failures

- **B-001** — expected DRAFT, got ERROR. (threw: Generated plan failed validation: item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "caption"; item 6 has unsupported content_form "caption"; item 7 has unsupported content_form "caption"; item 10 has unsupported content_form "hashtags")
- **B-002** — expected DRAFT, got ERROR. (threw: Generated plan failed validation: item 1 has unsupported content_form "calendar"; item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "caption"; item 6 has unsupported content_form "caption"; item 7 has unsupported content_form "caption"; item 8 has unsupported content_form "caption"; item 9 has unsupported content_form "caption"; item 11 has unsupported content_form "other")
- **B-003** — expected DRAFT, got ERROR. (threw: Generated plan failed validation: item 1 has unsupported content_form "caption"; item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "caption"; item 8 has unsupported content_form "story"; item 9 has unsupported content_form "hashtags")
- **B-004** — expected DRAFT, got ERROR. (threw: Generated plan failed validation: item 6 has unsupported content_form "other")
- **B-005** — expected DRAFT, got ERROR. (threw: Generated plan failed validation: item 1 has unsupported content_form "caption"; item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "caption"; item 6 has unsupported content_form "caption")
- **B-006** — expected DRAFT, got ERROR. (threw: Generated plan failed validation: item 1 has unsupported content_form "caption"; item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "caption"; item 6 has unsupported content_form "caption")
- **B-007** — expected DRAFT, got FLAG.
- **B-008** — expected DRAFT, got ERROR. (threw: Generated plan failed validation: item 8 has unsupported content_form "other")
- **B-009** — expected DRAFT, got ERROR. (threw: Generated plan failed validation: item 5 has unsupported content_form "caption")
- **B-010** — expected DRAFT, got ERROR. (threw: Generated plan failed validation: item 1 has unsupported content_form "caption"; item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 7 has unsupported content_form "other")
- **B-011** — expected DRAFT, got ERROR. (threw: Generated plan failed validation: item 1 has unsupported content_form "video script"; item 2 has unsupported content_form "video script"; item 3 has unsupported content_form "video script"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "caption"; item 6 has unsupported content_form "caption"; item 7 has unsupported content_form "caption"; item 8 has unsupported content_form "caption"; item 9 has unsupported content_form "hashtags")
- **B-014** — expected REQUEST_INFO, got ERROR. (threw: Generated plan failed validation: item 1 has unsupported content_form "caption"; item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "caption"; item 6 has unsupported content_form "caption")
- **B-015** — expected FLAG, got ERROR. (threw: Generated plan failed validation: item 1 has unsupported content_form "notification"; item 2 has unsupported content_form "caption")
- **B-016** — expected FLAG, got ERROR. (threw: Generated plan failed validation: item 1 has unsupported content_form "caption"; item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "caption"; item 6 has unsupported content_form "caption")
- **B-017** — expected FLAG, got ERROR. (threw: Generated plan failed validation: item 1 has unsupported content_form "caption")
- **B-018** — expected FLAG, got ERROR. (threw: 
Invalid `db.campaign.update()` invocation in
E:\Exology\Final Project\SkipDistances\lib\engine\queueOrFlag.ts:110:21

  107 const requestInfo = requestInfoResults(input.results);
  108 const campaignStatus = requestInfo.length > 0 ? "info_requested" : "in_progress";
  109 
→ 110 await db.campaign.update(
Operation has timed out)
- **B-019** — expected FLAG, got ERROR. (threw: fetch failed)
- **B-020** — expected FLAG, got ERROR. (threw: Generated plan failed validation: item 1 has unsupported content_form "caption"; item 2 has unsupported content_form "caption")
- **B-021** — expected FLAG, got ERROR. (threw: Generated plan failed validation: item 1 has unsupported content_form "caption"; item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "caption"; item 6 has unsupported content_form "caption")
- **B-023** — expected FLAG, got DRAFT.
- **B-024** — expected REFUSE_OVERRIDE, got ERROR. (threw: Generated plan failed validation: item 1 has unsupported content_form "caption"; item 2 has unsupported content_form "caption"; item 3 has unsupported content_form "caption"; item 4 has unsupported content_form "caption"; item 5 has unsupported content_form "story")
- **B-025** — expected REFUSE_OVERRIDE, got ERROR. (threw: 
Invalid `db.campaign.update()` invocation in
E:\Exology\Final Project\SkipDistances\lib\engine\queueOrFlag.ts:110:21

  107 const requestInfo = requestInfoResults(input.results);
  108 const campaignStatus = requestInfo.length > 0 ? "info_requested" : "in_progress";
  109 
→ 110 await db.campaign.update(
Operation has timed out)
