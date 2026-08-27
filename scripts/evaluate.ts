import "dotenv/config";

import fs from "node:fs";

import { prisma } from "../lib/db";
import { EVALUATION_REPORT_FILE } from "../lib/config/paths";
import { isOk } from "../lib/domain/decision";
import type { BriefAnalysis } from "../lib/engine/analyzeBrief";
import { analyzeBrief } from "../lib/engine/analyzeBrief";
import { judgeWithGemini } from "../lib/engine/complianceCheck";
import { generatePlan, type GeneratedPlan } from "../lib/engine/generatePlan";
import { isHalted, runIntake, type IntakeRunResult } from "../lib/engine/orchestrator";
import {
  loadAnswerKey,
  loadBriefs,
  type AnswerKeyEntry,
  type Brief,
} from "../tests/fixtures/loadBriefs";

/**
 * P12.1 — the graded evaluation harness.
 *
 * Runs all 27 fixture briefs through the *real* `runIntake` and scores each one
 * against `data/answer_key.json` on two axes: the decision it reached, and the
 * clause it cited for reaching it. Both matter. A run that flags B-015 for the
 * wrong reason has not understood the brief -- it has landed on the right answer
 * by luck, and a harness that scored only the decision would call that a pass.
 *
 * Two modes, and the default is the deliberate one:
 *
 *   `npm run evaluate`        deterministic -- the LLM steps are stubbed
 *   `npm run evaluate -- --live`  the real Gemini calls
 *
 * The default stubs `analyze`, `generate` and `judge` exactly as the P3.9 test
 * does. That is not the engine avoiding its own exam: every *guard* on the path
 * -- client resolution, completeness, override detection, the compliance gate,
 * queue-or-flag -- is the real implementation, and those are what the answer key
 * actually grades. What the stub removes is the model's freedom to return
 * something different on a Tuesday. A graded artifact a marker cannot reproduce
 * on a clean checkout, without an API key, is worth less than one they can.
 *
 * `--live` exists because the deterministic run cannot speak to how well the
 * *model* reads a brief, only to how well the pipeline holds. Both numbers go in
 * EVALUATION.md, clearly labelled as the different claims they are.
 *
 * Fixtures are run as real campaigns and deleted afterwards -- the same approach
 * the P3.9 test takes. They are evaluation inputs, never seeded rows.
 */

type Decision = AnswerKeyEntry["decision"];

type Row = {
  brief_id: string;
  expected: Decision;
  /** "ERROR" when the run threw -- never one of the four real decisions. */
  actual: Decision | "ERROR";
  decisionMatch: boolean;
  expectedClause: string | null;
  actualClause: string | null;
  /** Null when the key names no clause, so nothing is being asserted. */
  clauseMatch: boolean | null;
  pass: boolean;
  note: string;
};

/** Gap between briefs in `--live`, to stay under the free tier's 15/min. */
const LIVE_PACING_MS = 20_000;

/** Where the fixture campaign is parked when the brief names no real client. */
const FALLBACK_CLIENT = "CL-101";

/**
 * The deterministic stand-in for `analyze_brief`.
 *
 * Reads the header block literally -- exactly what `loadBriefs` parses and
 * nothing more. It deliberately does not infer: inferring here would pre-solve
 * the completeness check, which is one of the things being graded.
 */
function fixtureAnalysis(brief: Brief): BriefAnalysis {
  const fields = brief.fields;
  const channels = (fields.channels ?? "")
    .split(/\s*(?:,|\band\b|&)\s*/i)
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    client_reference: brief.client_raw || null,
    client_id: brief.client_id,
    title: brief.title,
    objective: fields.objective ?? null,
    audience: fields.audience ?? null,
    channels,
    deliverables: [
      { kind: "post", quantity: 1, raw: fields.deliverables ?? fields.deliverable ?? "content" },
    ],
    notes: fields.notes ?? null,
    date: brief.date,
    explicitly_missing: [],
  };
}

/**
 * Reduce a finished run to the single decision the answer key speaks in.
 *
 * Order matters. A halt outranks anything queued because it stopped the run
 * before generation; FLAG outranks REQUEST_INFO because a brief that both
 * violates a rule and misses a field is a violation first; and
 * `overrideRefusesScheduling` is checked last, since an override attempt still
 * drafts (clause 0.3 -- noted, never obeyed) and only refuses scheduling.
 */
function decisionOf(result: IntakeRunResult): { decision: Decision; clause: string | null } {
  if (!result.queued) {
    if (isHalted(result.intake)) {
      const outcome = result.intake.outcome;
      return {
        decision: outcome.decision as Decision,
        clause: isOk(outcome) ? null : outcome.clauseCode,
      };
    }
    return { decision: "DRAFT", clause: null };
  }

  const { flagged, requestInfo } = result.queued;

  if (flagged.length > 0) {
    return { decision: "FLAG", clause: flagged[0].clauseCode };
  }

  if (requestInfo.length > 0) {
    return { decision: "REQUEST_INFO", clause: requestInfo[0].outcome.clauseCode };
  }

  if (result.intake.overrideRefusesScheduling) {
    // The clause is 0.2 by definition -- override detection raises nothing else.
    return { decision: "REFUSE_OVERRIDE", clause: "0.2" };
  }

  /*
   * A drafted plan for a sensitive-sector client still cites a clause.
   *
   * Clause 1.8 is the mandatory-compliance-review rule, and the answer key
   * names it as the "key clause" on B-007 and B-008 -- briefs that are
   * correctly drafted, but must never be fast-tracked. The engine already
   * decides this (`requiresComplianceReview` on the client's industry); the
   * harness reads that decision rather than re-deriving it, so the report
   * cannot disagree with what the pipeline actually recorded.
   */
  if (result.queued.complianceReviewRequired) {
    return { decision: "DRAFT", clause: "1.8" };
  }

  return { decision: "DRAFT", clause: null };
}

/**
 * Compare two clause citations.
 *
 * Case- and whitespace-insensitive, because "cr.4" and "CR.4" are the same
 * citation and a harness that failed one of them would be grading typography.
 */
function sameClause(expected: string | null, actual: string | null): boolean {
  if (expected === null) return true;
  if (actual === null) return false;
  return expected.trim().toLowerCase() === actual.trim().toLowerCase();
}

/**
 * Retry a run that failed only because the API said "too many requests".
 *
 * The free tier allows 15 generate-content calls a minute, and one brief costs
 * several -- so 27 briefs back to back exhaust it long before the corpus is
 * finished. Without this, a `--live` report measures Google's rate limiter
 * rather than the engine, which is worse than not measuring at all.
 *
 * Only 429s are retried, and only a few times. Any other failure is a real
 * result and must reach the report unchanged.
 */
const RATE_LIMITED = /RESOURCE_EXHAUSTED|"code":\s*429|rate.?limit/i;

function retryDelayMs(message: string, attempt: number): number {
  // Google names the wait it wants; honour it, and fall back to a backoff.
  const named = /"retryDelay":\s*"(\d+)s"/.exec(message);
  if (named) return (Number(named[1]) + 2) * 1000;
  return Math.min(60_000, 5_000 * 2 ** attempt);
}

async function withRateLimitRetry<T>(run: () => Promise<T>, label: string): Promise<T> {
  const maxAttempts = 5;

  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= maxAttempts - 1 || !RATE_LIMITED.test(message)) throw error;

      const wait = retryDelayMs(message, attempt);
      console.log(`      ${label}: rate limited, waiting ${Math.round(wait / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function runOne(
  brief: Brief,
  key: AnswerKeyEntry,
  live: boolean,
): Promise<{ row: Row; campaignId: string }> {
  const campaign = await prisma.campaign.create({
    data: {
      // A brief naming no client on the roster (B-026) still needs somewhere to
      // live so the run can reach the resolution step that rejects it. The
      // engine reads the client from the *analysis*, not from this column.
      client_id: brief.client_id ?? FALLBACK_CLIENT,
      title: brief.title ?? brief.brief_id,
      raw_brief_text: brief.raw_text,
      status: "received",
    },
  });

  const dependencies = live
    ? { analyze: analyzeBrief, generate: generatePlan, judge: judgeWithGemini }
    : {
        analyze: async () => fixtureAnalysis(brief),
        generate: async (input: {
          analysis: BriefAnalysis;
          guidelines: { availableCodes: string[] };
        }): Promise<GeneratedPlan> => ({
          items: [
            {
              title: brief.title ?? brief.brief_id,
              content_form: "post" as const,
              platform: "instagram",
              // The brief's own words, so the compliance judge has the real
              // text to rule on rather than a placeholder.
              content_body: [input.analysis.objective, input.analysis.notes]
                .filter(Boolean)
                .join("\n"),
              market_id: null,
              scheduled_date: null,
              occasion_key: null,
              clause_codes: [input.guidelines.availableCodes[0]],
              rationale: null,
            },
          ],
          notes: null,
        }),
        // The real compliance *gate* still runs; this only stands in for the
        // model's opinion, which in the deterministic mode is "no objection".
        // Every rule-driven flag below therefore comes from a real guard.
        judge: async () => ({
          decision: "DRAFT" as const,
          clause_code: null,
          flag_type: null,
          reason: null,
        }),
      };

  let row: Row;

  try {
    const result = await withRateLimitRetry(
      () =>
        runIntake(campaign.campaign_id, prisma, dependencies as Parameters<typeof runIntake>[2]),
      brief.brief_id,
    );
    const { decision, clause } = decisionOf(result);

    const decisionMatch = decision === key.decision;
    const clauseMatch =
      key.violated_or_key_clause === null ? null : sameClause(key.violated_or_key_clause, clause);

    row = {
      brief_id: brief.brief_id,
      expected: key.decision,
      actual: decision,
      decisionMatch,
      expectedClause: key.violated_or_key_clause,
      actualClause: clause,
      clauseMatch,
      pass: decisionMatch && clauseMatch !== false,
      note: "",
    };
  } catch (error) {
    // A thrown run is a failure, not a crash of the harness: one bad brief must
    // not cost the other 26 their result.
    row = {
      brief_id: brief.brief_id,
      expected: key.decision,
      // Deliberately not "FLAG". A run that threw reached no decision at all,
      // and recording it as a flag would let a crash read as a correct refusal.
      actual: "ERROR",
      decisionMatch: false,
      expectedClause: key.violated_or_key_clause,
      actualClause: null,
      clauseMatch: false,
      pass: false,
      note: `threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { row, campaignId: campaign.campaign_id };
}

/** Remove every trace of the fixture run. These are inputs, never seeded rows. */
async function cleanup(campaignIds: string[]) {
  if (campaignIds.length === 0) return;
  const items = await prisma.contentItem.findMany({
    where: { campaign_id: { in: campaignIds } },
    select: { content_item_id: true },
  });
  const itemIds = items.map((i) => i.content_item_id);

  await prisma.auditLog.deleteMany({ where: { entity_id: { in: [...campaignIds, ...itemIds] } } });
  await prisma.contentItemCitation.deleteMany({ where: { content_item_id: { in: itemIds } } });
  await prisma.flag.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  await prisma.contentItem.deleteMany({ where: { campaign_id: { in: campaignIds } } });
  await prisma.campaign.deleteMany({ where: { campaign_id: { in: campaignIds } } });
}

function report(rows: Row[], live: boolean): string {
  const passed = rows.filter((r) => r.pass).length;
  const decisionsRight = rows.filter((r) => r.decisionMatch).length;
  const graded = rows.filter((r) => r.clauseMatch !== null);
  const clausesRight = graded.filter((r) => r.clauseMatch).length;
  const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);

  const lines: string[] = [];

  lines.push(`# Evaluation report`);
  lines.push("");
  lines.push(`Mode: **${live ? "live (real Gemini)" : "deterministic (stubbed LLM)"}**  `);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`| Measure | Score | |`);
  lines.push(`|---|---|---|`);
  lines.push(`| Briefs fully correct | ${passed} / ${rows.length} | ${pct(passed, rows.length)} |`);
  lines.push(
    `| Decision correct | ${decisionsRight} / ${rows.length} | ${pct(decisionsRight, rows.length)} |`,
  );
  lines.push(
    `| Clause correct (where asserted) | ${clausesRight} / ${graded.length} | ${pct(clausesRight, graded.length)} |`,
  );

  // Called out separately: a run that threw never reached a decision, so it is
  // a different kind of failure from one that decided wrongly.
  const errored = rows.filter((r) => r.actual === "ERROR").length;
  if (errored > 0) {
    lines.push(`| Runs that threw before deciding | ${errored} / ${rows.length} | |`);
  }
  lines.push("");
  lines.push(`## Per brief`);
  lines.push("");
  lines.push(`| Brief | Expected | Actual | Clause expected | Clause cited | Result |`);
  lines.push(`|---|---|---|---|---|---|`);

  for (const r of rows) {
    const mark = r.pass ? "pass" : "**FAIL**";
    const detail = r.note ? ` ${r.note}` : "";
    lines.push(
      `| ${r.brief_id} | ${r.expected} | ${r.actual} | ${r.expectedClause ?? "—"} | ${r.actualClause ?? "—"} | ${mark}${detail} |`,
    );
  }

  const failures = rows.filter((r) => !r.pass);
  lines.push("");
  lines.push(`## Failures`);
  lines.push("");
  if (failures.length === 0) {
    lines.push(`None. Every brief reached the expected decision and cited the expected clause.`);
  } else {
    for (const r of failures) {
      const why = !r.decisionMatch
        ? `expected ${r.expected}, got ${r.actual}`
        : `decision right, clause wrong — expected ${r.expectedClause}, cited ${r.actualClause ?? "none"}`;
      lines.push(`- **${r.brief_id}** — ${why}.${r.note ? ` (${r.note})` : ""}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const live = process.argv.includes("--live");

  if (live && !process.env.GEMINI_API_KEY) {
    console.error("--live needs GEMINI_API_KEY set.");
    process.exit(1);
  }

  const briefs = loadBriefs();
  const answerKey = loadAnswerKey();

  const rows: Row[] = [];
  const campaignIds: string[] = [];

  try {
    for (const brief of briefs) {
      const key = answerKey[brief.brief_id];
      if (!key) {
        console.error(`No answer key entry for ${brief.brief_id}; skipping.`);
        continue;
      }

      /*
       * Paced, in live mode only.
       *
       * A brief costs several generate-content calls and the free tier allows
       * 15 a minute. Retrying after a 429 recovers, but bursting into the limit
       * and waiting it out on every brief takes far longer than simply not
       * bursting. The retry above stays as the safety net.
       */
      if (live && rows.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, LIVE_PACING_MS));
      }

      const { row, campaignId } = await runOne(brief, key, live);
      campaignIds.push(campaignId);
      rows.push(row);

      const mark = row.pass ? "PASS" : "FAIL";
      console.log(
        `${mark}  ${row.brief_id}  expected ${row.expected}/${row.expectedClause ?? "—"}  got ${row.actual}/${row.actualClause ?? "—"}`,
      );
    }
  } finally {
    // Always, even on an interrupt: leaving 27 fixture campaigns in the
    // database would corrupt every count the dashboards show.
    await cleanup(campaignIds);
  }

  const markdown = report(rows, live);
  fs.writeFileSync(EVALUATION_REPORT_FILE, markdown, "utf8");

  const passed = rows.filter((r) => r.pass).length;
  console.log("");
  console.log(`${passed}/${rows.length} briefs fully correct.`);
  console.log(`Report written to ${EVALUATION_REPORT_FILE}`);

  // A non-zero exit on any failure, so CI or `npm run check` can gate on it.
  process.exit(passed === rows.length ? 0 : 1);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
