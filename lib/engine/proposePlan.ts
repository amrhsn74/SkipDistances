import { prisma, type Db } from "../db";
import { analyzeBrief } from "./analyzeBrief";
import { generatePlan, type GeneratedPlan } from "./generatePlan";
import { planningWindow, resolveCalendar } from "./resolveCalendar";
import { searchGuidelines } from "./searchGuidelines";
import { runIntakeSteps, isHalted, haltClause, type IntakeResult } from "./orchestrator";

/**
 * Propose a plan without drafting one.
 *
 * The chat path's answer to "the thread now says enough". Before this existed,
 * a complete thread went straight to `submitBrief` and the creator was handed
 * finished content they had never asked for item by item -- every proposal
 * drafted, judged, persisted and illustrated, whether they wanted it or not.
 *
 * So the pipeline is cut in half. This runs the guarded front of it -- extract,
 * resolve the client, check completeness, detect an override, retrieve the
 * client's clauses, generate the plan -- and stops at the plan. Nothing is
 * persisted as content, nothing is judged for compliance, and no image is made.
 * The creator sees what the engine would produce and picks.
 *
 * When they pick, `chatTurn` calls `submitBrief` with their indices and the
 * whole pipeline runs properly on the chosen items, compliance and all. That is
 * the reason this deliberately does NOT return anything that could be mistaken
 * for a draft: the proposal is an offer, and the content that eventually exists
 * is generated and judged by the ordinary path, not lifted out of here.
 *
 * The guards that halt a brief still halt it *here*, before a creator is shown a
 * choice they cannot act on. An unknown client, an incomplete brief -- these
 * come back as a halt and the thread reports it, exactly as the drafting path
 * would have.
 */

export type ProposedItem = {
  title: string;
  content_form: string;
  platform: string | null;
  /** A one-line summary so the creator can tell two proposals apart. */
  summary: string | null;
  /** The clauses this item would be written under, shown before it is drafted. */
  clause_codes: string[];
};

export type ProposeResult =
  /**
   * The engine could not get as far as a plan. Carries the same clause and
   * reason the drafting path would have reported.
   */
  | {
      status: "halted";
      intake: IntakeResult;
      clauseCode: string;
      reason: string;
    }
  | {
      status: "proposed";
      items: ProposedItem[];
      notes: string | null;
    };

export type ProposeDependencies = {
  analyze: typeof analyzeBrief;
  generate: typeof generatePlan;
};

const defaultDependencies: ProposeDependencies = {
  analyze: analyzeBrief,
  generate: generatePlan,
};

/**
 * What the creator is shown, from what the model generated.
 *
 * `content_body` is deliberately reduced to a short summary rather than passed
 * through. A proposal is a choice between shapes of work, not a preview of
 * finished copy -- and copy that has not been through `complianceCheck` must
 * never be displayed as though it had. Showing the full body here would put
 * unjudged text in front of a creator with nothing marking it as unjudged.
 */
export function toProposedItems(plan: GeneratedPlan): ProposedItem[] {
  return plan.items.map((item) => ({
    title: item.title,
    content_form: item.content_form,
    platform: item.platform,
    summary: summarise(item.content_body ?? item.rationale),
    clause_codes: item.clause_codes,
  }));
}

const SUMMARY_CHARS = 140;

function summarise(text: string | null): string | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.length <= SUMMARY_CHARS) return trimmed;
  return `${trimmed.slice(0, SUMMARY_CHARS).trimEnd()}…`;
}

/**
 * Run the guarded front of the pipeline and stop at the plan.
 *
 * Takes brief text rather than a campaign id, and that is the point: no campaign
 * row is created to propose. A creator who is offered three items and picks none
 * leaves nothing behind in the account manager's queue.
 */
export async function proposePlan(
  clientId: string,
  briefText: string,
  db: Db = prisma,
  dependencies: ProposeDependencies = defaultDependencies,
): Promise<ProposeResult> {
  const analysis = await dependencies.analyze(briefText);

  // The same intake guards the drafting path runs, run before the creator is
  // shown anything. A halt here is the engine declining to propose, and it is
  // reported with its clause rather than as an empty list.
  const intake = await runIntakeSteps({ analysis }, db);

  if (isHalted(intake)) {
    const outcome = intake.outcome;
    return {
      status: "halted",
      intake,
      clauseCode: haltClause(intake),
      reason:
        "reason" in outcome && typeof outcome.reason === "string"
          ? outcome.reason
          : "The engine cannot draft from this yet.",
    };
  }

  const calendar = await resolveCalendar(
    intake.client.client_id,
    planningWindow({ from: analysis.date }),
    db,
  );

  // The client's own clauses, retrieved through the same double-scoped query the
  // drafting path uses. A proposal is grounded in exactly what a draft would be.
  const guidelines = await searchGuidelines(intake.client.client_id, db);

  const plan = await dependencies.generate(
    { client: intake.client, analysis, calendar, guidelines },
    db,
  );

  return {
    status: "proposed",
    items: toProposedItems(plan),
    notes: plan.notes,
  };
}
