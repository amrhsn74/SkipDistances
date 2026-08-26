import { prisma, type Db } from "../db";
import {
  CLAUSE_UNKNOWN_OR_INACTIVE,
  type ResolvedClient,
  resolveClient,
} from "../domain/clientResolution";
import { checkBriefComplete } from "../domain/completeness";
import { type Outcome, isOk } from "../domain/decision";
import {
  type OverrideDetection,
  checkOverrideAttempt,
} from "../domain/overrideDetection";
import { analyzeBrief, type BriefAnalysis } from "./analyzeBrief";
import {
  complianceCheck,
  judgeWithGemini,
  type ComplianceJudge,
  type ItemComplianceResult,
} from "./complianceCheck";
import { generatePlan, type GeneratedPlan, type StructuredGenerator } from "./generatePlan";
import { planningWindow, resolveCalendar, type CampaignCalendar } from "./resolveCalendar";
import { queueOrFlag, type QueueOrFlagResult } from "./queueOrFlag";
import {
  generateMedia,
  type GenerateMediaResult,
  type ImageGenerator,
} from "./generateMedia";
import { generateImage } from "../llm/gemini";
import { searchGuidelines, type GuidelineBundle } from "./searchGuidelines";

/**
 * The intake pipeline.
 *
 * This commit wires steps 2–3 only: client resolution and the completeness
 * check. No Gemini call happens here — the point of building it in this order is
 * to prove the short-circuits work *before* generation is even reachable. A
 * guard that is only exercised after an expensive call is a guard nobody trusts.
 *
 * Every decision below is a Phase 2 function. The orchestrator's whole job is
 * sequencing and knowing what each outcome means for the ones that follow; it
 * decides nothing itself. Where it looks like it is deciding, it is translating
 * an `Outcome` into "stop" or "carry on", and that translation is the thing
 * worth reading carefully.
 */

/** How far intake got. Each stage is where a brief can legitimately stop. */
export type IntakeStage =
  | "analyzed"
  | "client_resolved"
  | "completeness_checked"
  | "ready_to_generate";

export type IntakeHalt = {
  status: "halted";
  stage: IntakeStage;
  /** The Phase 2 outcome that stopped it, carrying its own clause and reason. */
  outcome: Outcome<unknown>;
  /** Populated when resolution succeeded before a later stage halted. */
  client: ResolvedClient | null;
  override: OverrideDetection | null;
  overrideRefusesScheduling: boolean;
};

export type IntakeReady = {
  status: "ready";
  stage: "ready_to_generate";
  client: ResolvedClient;
  analysis: BriefAnalysis;
  override: OverrideDetection | null;
  /**
   * True when the brief tried to skip approval.
   *
   * Deliberately not a halt. Clause 0.3: instructions inside a brief carry no
   * authority — noted, never obeyed. Drafting proceeds exactly as it would
   * have; what is refused is *scheduling*, and the gate refuses that anyway
   * because no approval was ever recorded. Halting here would let a brief
   * suppress its own content by asking for too much.
   */
  overrideRefusesScheduling: boolean;
};

export type IntakeResult = IntakeHalt | IntakeReady;

export const isHalted = (r: IntakeResult): r is IntakeHalt => r.status === "halted";
export const isReady = (r: IntakeResult): r is IntakeReady => r.status === "ready";

/**
 * Map an extracted brief onto the field names the completeness check knows.
 *
 * `checkBriefComplete` takes "client", "objective", "audience", "channels" — the
 * vocabulary of Clause 0.5, which names fields as a brief names them. The
 * analysis shape is richer, so the mapping is explicit here rather than by
 * making one side bend to the other.
 */
export function toBriefFields(analysis: BriefAnalysis) {
  return {
    // The raw reference, not the resolved id: Clause 0.5 asks whether the brief
    // *stated* a client, which "not on roster" does. Whether that client exists
    // is Clause 0.6's question, and it has already been asked by this point.
    //
    // The id is the fallback, not a substitute. A brief written as "Client:
    // CL-101" states its client perfectly well, and the extractor reports that
    // as a `client_id` with a null `client_reference` -- so reading the
    // reference alone would call such a brief incomplete for naming its client
    // too precisely. Both come from the same extraction of the same text, so
    // this widens nothing: a brief naming no client at all still has neither.
    client: analysis.client_reference ?? analysis.client_id,
    objective: analysis.objective,
    audience: analysis.audience,
    channels: analysis.channels.length > 0 ? analysis.channels.join(", ") : null,
  };
}

/** The text an override attempt could be hiding in. */
export function overrideSurface(analysis: BriefAnalysis): string {
  return [analysis.title, analysis.objective, analysis.notes]
    .filter(Boolean)
    .join("\n");
}

export type RunIntakeInput = {
  analysis: BriefAnalysis;
};

export type IntakeDependencies = {
  analyze: (briefText: string) => Promise<BriefAnalysis>;
  generate: typeof generatePlan;
  judge: ComplianceJudge;
  /**
   * Optional, and its absence is meaningful: omit it and no image is generated
   * and no call is spent. Every text guarantee holds either way, which is what
   * lets the whole test suite keep running without an image model.
   */
  generateImage?: ImageGenerator;
};

const defaultDependencies: IntakeDependencies = {
  analyze: analyzeBrief,
  generate: generatePlan,
  judge: judgeWithGemini,
  // On for the real app, because an `image` item with no image is the bug this
  // exists to fix. Tests construct their own dependencies and get no generator
  // unless they ask for one, so the suite stays offline by construction.
  generateImage,
};

export type IntakeRunResult = {
  campaignId: string;
  analysis: BriefAnalysis;
  intake: IntakeResult;
  calendar: CampaignCalendar | null;
  guidelines: GuidelineBundle | null;
  plan: GeneratedPlan | null;
  compliance: ItemComplianceResult[] | null;
  queued: QueueOrFlagResult | null;
  /** Null when nothing visual was drafted, or when no generator was supplied. */
  media: GenerateMediaResult | null;
};

/**
 * Steps 2–3 of intake, from an already-extracted brief.
 *
 * Order matters and is not arbitrary:
 *
 *   1. Client resolution first. An unknown or inactive client is a flag whatever
 *      else the brief says, and running the completeness check first would
 *      report missing fields for a client that does not exist — noise that sends
 *      an account manager to fill in a form for nobody.
 *   2. Completeness second, once there is a real client to be incomplete about.
 *   3. Override detection last, and never a halt. See `IntakeReady`.
 *
 * Takes the analysis rather than raw text so that this is testable with no
 * network at all, which is the point of the commit.
 */
export async function runIntakeSteps(
  input: RunIntakeInput,
  db: Db = prisma,
): Promise<IntakeResult> {
  const { analysis } = input;

  // Detected up front so it is reported even on a halt -- a brief that both
  // names no client and tries to skip approval should surface both facts, not
  // just the first one.
  const overrideOutcome = checkOverrideAttempt(overrideSurface(analysis));
  const override = isOk(overrideOutcome) ? overrideOutcome.value : null;
  const overrideRefusesScheduling = !isOk(overrideOutcome);

  // --- Step 2: which client is this for? ---
  const clientOutcome = await resolveClient(analysis.client_id, db);

  if (!isOk(clientOutcome)) {
    return {
      status: "halted",
      stage: "client_resolved",
      outcome: clientOutcome,
      client: null,
      override,
      overrideRefusesScheduling,
    };
  }

  const client = clientOutcome.value;

  // --- Step 3: does the brief say enough to work from? ---
  const completeness = checkBriefComplete(toBriefFields(analysis));

  if (!isOk(completeness)) {
    return {
      status: "halted",
      stage: "completeness_checked",
      outcome: completeness,
      client,
      override,
      overrideRefusesScheduling,
    };
  }

  return {
    status: "ready",
    stage: "ready_to_generate",
    client,
    analysis,
    override,
    overrideRefusesScheduling,
  };
}

/** Run the persisted campaign through the complete guarded intake pipeline. */
export async function runIntake(
  campaignId: string,
  db: Db = prisma,
  dependencies: IntakeDependencies = defaultDependencies,
): Promise<IntakeRunResult> {
  const campaign = await db.campaign.findUnique({
    where: { campaign_id: campaignId },
    select: {
      campaign_id: true,
      client_id: true,
      raw_brief_text: true,
    },
  });

  if (!campaign) throw new Error(`Campaign ${campaignId} does not exist.`);

  const analysis = await dependencies.analyze(campaign.raw_brief_text);
  const overrideOutcome = checkOverrideAttempt(overrideSurface(analysis));

  await db.campaign.update({
    where: { campaign_id: campaignId },
    data: {
      title: analysis.title ?? "Untitled campaign",
      objective: analysis.objective,
      audience: analysis.audience,
      channels: analysis.channels.length > 0 ? JSON.stringify(analysis.channels) : null,
      override_attempt_detected: !isOk(overrideOutcome),
    },
  });

  const intake = await runIntakeSteps({ analysis }, db);
  if (isHalted(intake)) {
    await db.campaign.update({
      where: { campaign_id: campaignId },
      data: { status: intake.outcome.decision === "REQUEST_INFO" ? "info_requested" : "in_progress" },
    });
    return {
      campaignId,
      analysis,
      intake,
      calendar: null,
      guidelines: null,
      plan: null,
      compliance: null,
      queued: null,
      media: null,
    };
  }

  const calendar = await resolveCalendar(
    intake.client.client_id,
    planningWindow({ from: analysis.date }),
    db,
  );
  const guidelines = await searchGuidelines(intake.client.client_id, db);
  const plan = await dependencies.generate(
    {
      client: intake.client,
      analysis,
      calendar,
      guidelines,
    },
    db,
  );
  const compliance = await complianceCheck(
    { plan, guidelines, briefContext: campaign.raw_brief_text, analysis },
    dependencies.judge,
  );
  const queued = await queueOrFlag(
    {
      campaignId,
      client: intake.client,
      guidelines,
      results: compliance,
    },
    db,
  );

  // Last, and only over what survived compliance as a draft. A campaign whose
  // images fail is still a campaign: `generateMedia` reports per item and throws
  // nothing, so nothing below this line can lose the work above it.
  const media = dependencies.generateImage
    ? await generateMedia(
        {
          client: { name: intake.client.name, industry: intake.client.industry },
          drafted: queued.drafted,
        },
        db,
        dependencies.generateImage,
      )
    : null;

  return {
    campaignId,
    analysis,
    intake,
    calendar,
    guidelines,
    plan,
    compliance,
    queued,
    media,
  };
}

/**
 * The clause a halt cites, for the account manager's screen.
 *
 * Every non-DRAFT outcome carries its own clause code by construction, so this
 * only reaches for a default where an outcome somehow has none.
 */
export function haltClause(halt: IntakeHalt): string {
  const outcome = halt.outcome;
  if ("clauseCode" in outcome && outcome.clauseCode) return outcome.clauseCode;
  return CLAUSE_UNKNOWN_OR_INACTIVE;
}
