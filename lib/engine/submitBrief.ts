import { prisma, type Db } from "../db";
import { writeAudit } from "../domain/auditLog";
import {
  haltClause,
  isHalted,
  runIntake,
  type IntakeDependencies,
  type IntakeRunResult,
} from "./orchestrator";

/**
 * Submitting a brief: persist it, then run it through the guarded engine.
 *
 * `runIntake` takes a `campaignId`, not raw text -- it reads the brief from the
 * row and writes its findings back to it. So something has to create that row
 * first, and that something is here rather than in the route handler, for the
 * same reason `clientRoster` exists: the validation, the id of the submitting
 * user, and the audit row are rules, and a rule written in a route handler is a
 * rule the next caller re-derives slightly differently.
 *
 * It sits in `lib/engine` rather than `lib/domain` because it calls `runIntake`.
 * The domain layer is kept pure -- unit-testable with no network -- and a module
 * that reaches the engine belongs on the engine side of that line, even though
 * its own work is persistence and validation.
 *
 * Why the caller names the client rather than the engine discovering it:
 * `Campaign.client_id` is a foreign key, so it must point at a real client
 * before the row exists -- and `analyzeBrief`, which reads the client out of the
 * text, only runs once the row does. Naming it up front is also what makes
 * `campaign.submit` checkable against a specific client *before* a single Gemini
 * token is spent, rather than after.
 *
 * That is not a hole in Clause 0.6. The named client is still resolved by
 * `resolveClient` inside the pipeline, and a brief whose text names a different
 * or unknown client still halts and flags there. This only decides which roster
 * row the brief is filed against; it decides nothing about whether that client
 * may be drafted for.
 */

export class CampaignValidationError extends Error {
  readonly code = "CAMPAIGN_VALIDATION";
  /** Field-keyed so an intake form can show each message against its input. */
  readonly issues: Record<string, string>;

  constructor(issues: Record<string, string>) {
    super(`Invalid brief: ${Object.keys(issues).join(", ")}.`);
    this.name = "CampaignValidationError";
    this.issues = issues;
  }
}

export type SubmitBriefInput = {
  /** The roster row this brief is filed against. Must exist -- it is an FK. */
  clientId: string;
  /** The brief as written. The engine reads this, not the fields below. */
  rawBriefText: string;
  /** A working title until `analyzeBrief` extracts a better one. */
  title?: string | null;
  /** Set only when the account manager built the brief around a known occasion. */
  relatedOccasionId?: string | null;
};

/** One of the PRD's four intake outcomes. */
export type IntakeOutcome = "DRAFT" | "FLAG" | "REQUEST_INFO" | "REFUSE_OVERRIDE";

/** What a submitted brief looks like once the pipeline has had its say. */
export type SubmitBriefResult = {
  campaign: {
    campaign_id: string;
    client_id: string;
    title: string;
    status: string;
    override_attempt_detected: boolean;
    compliance_review_required: boolean;
  };
  outcome: IntakeOutcome;
  /** The clause the outcome cites, where it cites one. */
  clauseCode: string | null;
  /** Human-readable reason for the outcome, straight from the Phase 2 result. */
  reason: string | null;
  counts: { drafted: number; flagged: number; requestInfo: number };
  /** The full engine result, for a screen that wants the detail. */
  run: IntakeRunResult;
};

/**
 * Persist a brief and run it.
 *
 * The campaign row is created before the engine runs and is *kept* whatever the
 * engine decides. A flagged or incomplete brief is not a failed submission --
 * the PRD's flag-resolution flow is an account manager revising and re-running
 * that same campaign, which needs the row and its `raw_brief_text` to still be
 * there. Deleting it on a flag would turn "fix the one issue" into "retype the
 * brief".
 */
export async function submitBrief(
  input: SubmitBriefInput,
  submittedById: string,
  db: Db = prisma,
  dependencies?: IntakeDependencies,
): Promise<SubmitBriefResult> {
  const issues: Record<string, string> = {};

  const clientId = (input.clientId ?? "").trim();
  if (!clientId) issues.clientId = "A brief names the client it is for.";

  const rawBriefText = (input.rawBriefText ?? "").trim();
  if (!rawBriefText) issues.rawBriefText = "A brief needs its text.";

  if (Object.keys(issues).length > 0) throw new CampaignValidationError(issues);

  // Checked here rather than left to the foreign key, because an FK failure
  // surfaces as a 500 with a Prisma message, and "no such client" is a caller
  // error the intake form should be able to show against its own field.
  //
  // Note this is an existence check, not an eligibility one: an *inactive*
  // client passes here and is flagged by `resolveClient` inside the pipeline,
  // where Clause 0.6 lives. Refusing inactive clients here as well would put the
  // same rule in two places and cite it from neither.
  const client = await db.client.findUnique({
    where: { client_id: clientId },
    select: { client_id: true },
  });
  if (!client) {
    throw new CampaignValidationError({ clientId: `No client ${clientId} on the roster.` });
  }

  if (input.relatedOccasionId) {
    const occasion = await db.occasion.findUnique({
      where: { occasion_id: input.relatedOccasionId },
      select: { occasion_id: true },
    });
    if (!occasion) {
      throw new CampaignValidationError({
        relatedOccasionId: `No occasion ${input.relatedOccasionId}.`,
      });
    }
  }

  const campaign = await db.campaign.create({
    data: {
      client_id: clientId,
      // `analyzeBrief` overwrites this from the text a moment later. A
      // placeholder rather than a required field, because a brief pasted into a
      // box legitimately has no separate title of its own.
      title: (input.title ?? "").trim() || "Untitled brief",
      raw_brief_text: rawBriefText,
      related_occasion_id: input.relatedOccasionId ?? null,
      submitted_by_id: submittedById,
      status: "received",
    },
    select: { campaign_id: true },
  });

  await writeAudit(
    {
      entityType: "Campaign",
      entityId: campaign.campaign_id,
      action: "created",
      performedById: submittedById,
      details: { client_id: clientId, brief_length: rawBriefText.length },
    },
    db,
  );

  const run = await runIntake(campaign.campaign_id, db, dependencies);

  // Re-read rather than returning the pre-run row: `runIntake` writes the
  // extracted title, the override flag and the status back to it, and
  // `queueOrFlag` sets `compliance_review_required`. The stale copy would report
  // a sensitive-sector client as needing no compliance review.
  const persisted = await db.campaign.findUniqueOrThrow({
    where: { campaign_id: campaign.campaign_id },
    select: {
      campaign_id: true,
      client_id: true,
      title: true,
      status: true,
      override_attempt_detected: true,
      compliance_review_required: true,
    },
  });

  return {
    campaign: persisted,
    outcome: outcomeOf(run),
    clauseCode: clauseOf(run),
    reason: reasonOf(run),
    counts: {
      drafted: run.queued?.drafted.length ?? 0,
      flagged: run.queued?.flagged.length ?? 0,
      requestInfo: run.queued?.requestInfo.length ?? 0,
    },
    run,
  };
}

/**
 * One of the four outcomes, from a run.
 *
 * The order is the point. A halt wins over anything the items say, because a
 * halted brief produced no items at all. Among items, a flag outranks a request
 * for information, which outranks a clean draft -- the strongest signal in the
 * plan is what an account manager needs to see on the queue row.
 *
 * `REFUSE_OVERRIDE` is checked last, and only when nothing else fired, because
 * Clause 0.3 makes it a *scheduling* refusal rather than a drafting one: the
 * content is drafted normally and the attempt is recorded. It ranks below a flag
 * because a brief that both breaks a rule and asks to skip review is, first, a
 * brief that breaks a rule.
 */
export function outcomeOf(run: IntakeRunResult): IntakeOutcome {
  if (isHalted(run.intake)) {
    return run.intake.outcome.decision === "REQUEST_INFO" ? "REQUEST_INFO" : "FLAG";
  }

  if (run.queued) {
    if (run.queued.flagged.length > 0) return "FLAG";
    if (run.queued.requestInfo.length > 0) return "REQUEST_INFO";
  }

  if (run.intake.overrideRefusesScheduling) return "REFUSE_OVERRIDE";
  return "DRAFT";
}

/**
 * The clause the outcome cites.
 *
 * A halt carries its own code. An item-level outcome does not, quite: a flagged
 * item records `clauseId` -- the database id of the clause row -- while the
 * *code* ("1.1", "NF.4") is what a reviewer reads and what `answer_key.json`
 * grades against. So the code is looked up from the guideline bundle the run
 * already retrieved, rather than by going back to the database for a row the
 * pipeline has in hand.
 */
function clauseOf(run: IntakeRunResult): string | null {
  if (isHalted(run.intake)) return haltClause(run.intake);

  const flaggedClauseId = run.queued?.flagged[0]?.clauseId;
  if (flaggedClauseId) {
    const clause = run.guidelines?.all.find((c) => c.clause_id === flaggedClauseId);
    if (clause) return clause.clause_code;
  }

  return run.queued?.requestInfo[0]?.outcome.clauseCode ?? null;
}

function reasonOf(run: IntakeRunResult): string | null {
  if (isHalted(run.intake)) {
    const outcome = run.intake.outcome;
    return "reason" in outcome && typeof outcome.reason === "string" ? outcome.reason : null;
  }
  return run.queued?.requestInfo[0]?.outcome.reason ?? null;
}
