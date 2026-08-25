import {
  flag,
  isOk,
  ok,
  type FlagType,
  type Outcome,
} from "../domain/decision";
import {
  CLAUSE_SUPERLATIVE,
  checkSubstantiation,
  hasSubstantiation,
} from "../domain/substantiation";
import {
  TEMPERATURE,
  type GenerateOptions,
  generateStructured,
} from "../llm/gemini";
import type { BriefAnalysis } from "./analyzeBrief";
import type { GeneratedPlan, GeneratedPlanItem } from "./generatePlan";
import {
  type GuidelineBundle,
  formatGuidelinesForPrompt,
  isCitable,
} from "./searchGuidelines";

/**
 * Step 7: check generated items before anything is queued.
 *
 * The sharpest rules are deterministic here, because a model should not be
 * asked whether "guaranteed returns" is a guaranteed-results claim. Softer brand
 * fit still goes through a small structured judgment call, but any flagged
 * clause it returns is validated against the retrieved bundle before being
 * accepted.
 */

export type ComplianceCheckInput = {
  plan: GeneratedPlan;
  guidelines: GuidelineBundle;
  /** Raw brief or extracted fields, used only as source context for claims. */
  briefContext?: string;
  analysis?: BriefAnalysis;
};

export type ItemComplianceResult = {
  item: GeneratedPlanItem;
  outcome: Outcome<GeneratedPlanItem>;
  source: "deterministic" | "model";
};

export type ComplianceJudgment = {
  decision: "DRAFT" | "FLAG";
  clause_code: string | null;
  flag_type: FlagType | null;
  reason: string | null;
};

export type ComplianceJudgeContext = {
  guidelines: GuidelineBundle;
  briefContext: string;
};

export type ComplianceJudge = (
  item: GeneratedPlanItem,
  context: ComplianceJudgeContext,
) => Promise<ComplianceJudgment>;

export type StructuredGenerator = <T>(
  prompt: string,
  schema: object,
  options?: GenerateOptions,
) => Promise<T>;

export class InvalidComplianceJudgmentError extends Error {
  readonly code = "INVALID_COMPLIANCE_JUDGMENT";
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Compliance judgment failed validation: ${problems.join("; ")}`);
    this.name = "InvalidComplianceJudgmentError";
    this.problems = problems;
  }
}

export const COMPLIANCE_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string" },
    clause_code: { type: "string", nullable: true },
    flag_type: { type: "string", nullable: true },
    reason: { type: "string", nullable: true },
  },
  required: ["decision", "clause_code", "flag_type"],
} as const;

const SYSTEM_INSTRUCTION = `You are a compliance reviewer for Skip Studio.

Judge only the generated item against the provided retrieved clauses and brief
context. Do not introduce policies or clauses that are not shown. Return DRAFT
when the item complies. Return FLAG only when the item conflicts with a retrieved
agency or brand clause, and cite that clause code exactly.`;

const COMPLIANCE_FLAG_TYPES: FlagType[] = [
  "brand_violation",
  "compliance_violation",
];

/**
 * Check every generated item.
 */
export async function complianceCheck(
  input: ComplianceCheckInput,
  judge: ComplianceJudge = (item, context) => judgeWithGemini(item, context),
): Promise<ItemComplianceResult[]> {
  const briefContext = input.briefContext ?? contextFromAnalysis(input.analysis);
  const results: ItemComplianceResult[] = [];

  for (const item of input.plan.items) {
    const deterministic = deterministicCompliance(item, input.guidelines, briefContext);
    if (!isOk(deterministic)) {
      results.push({ item, outcome: deterministic, source: "deterministic" });
      continue;
    }

    const judgment = await judge(item, {
      guidelines: input.guidelines,
      briefContext,
    });
    results.push({
      item,
      outcome: judgmentToOutcome(item, judgment, input.guidelines),
      source: "model",
    });
  }

  return results;
}

/**
 * The model-backed soft check, kept injectable so unit tests need no key.
 */
export async function judgeWithGemini(
  item: GeneratedPlanItem,
  context: ComplianceJudgeContext,
  generator: StructuredGenerator = generateStructured,
): Promise<ComplianceJudgment> {
  return generator<ComplianceJudgment>(
    buildCompliancePrompt(item, context),
    COMPLIANCE_SCHEMA,
    {
      temperature: TEMPERATURE.deterministic,
      systemInstruction: SYSTEM_INSTRUCTION,
      maxOutputTokens: 1024,
    },
  );
}

export function buildCompliancePrompt(
  item: GeneratedPlanItem,
  context: ComplianceJudgeContext,
): string {
  return `Review this generated item against the retrieved clauses.

Brief context:
${context.briefContext || "No additional brief context."}

Generated item:
${JSON.stringify(
  {
    title: item.title,
    content_form: item.content_form,
    platform: item.platform,
    content_body: item.content_body,
    market_id: item.market_id,
    scheduled_date: item.scheduled_date?.toISOString().slice(0, 10) ?? null,
    clause_codes: item.clause_codes,
    rationale: item.rationale,
  },
  null,
  2,
)}

Retrieved clauses:
${formatGuidelinesForPrompt(context.guidelines)}

Return:
- decision: DRAFT or FLAG
- clause_code: null for DRAFT, otherwise a retrieved clause code
- flag_type: null for DRAFT, otherwise brand_violation or compliance_violation
- reason: concise explanation for a human reviewer`;
}

export function deterministicCompliance(
  item: GeneratedPlanItem,
  guidelines: GuidelineBundle,
  briefContext = "",
): Outcome<GeneratedPlanItem> {
  const itemText = itemSurface(item);

  const substantiation = checkSubstantiation(itemText);
  if (!isOk(substantiation) && !hasSubstantiation(briefContext)) {
    return substantiation;
  }

  const rules = [
    brandRule("CR.4", "brand_violation", DISCOUNT_PATTERNS, "Cairo Roast does not allow discounts, promo codes, flash sales or price-led messaging."),
    brandRule(
      "GG.4",
      "brand_violation",
      ORGANIC_PATTERNS,
      "GreenGrocer may use organic only for certified product lines listed in the brief.",
      (text, brief) => !hasCertification(`${text}\n${brief}`),
    ),
    brandRule("MC.4", "brand_violation", MEDCARE_SYMPTOM_PATTERNS, "MedCare does not allow symptom checklists or diagnostic-style content."),
    brandRule("LF.4", "brand_violation", COMPETITOR_MOCKERY_PATTERNS, "Layla must not name or mock competitor brands."),
    agencyRule("1.1", "compliance_violation", HEALTH_CLAIM_PATTERNS, "Content must not make medical, health-outcome, weight-loss or diagnostic claims."),
    agencyRule("1.2", "compliance_violation", GUARANTEE_PATTERNS, "Content must not promise guaranteed returns, approvals, sales or time-bound results."),
    agencyRule("1.4", "compliance_violation", PAID_DISCLOSURE_PATTERNS, "Paid, gifted or influencer content needs clear disclosure."),
    agencyRule("1.7", "compliance_violation", POLITICAL_NEWS_PATTERNS, "Content must stay clear of political or news-tied topics unless explicitly allowed."),
    brandRule("NB.4", "brand_violation", FINANCE_URGENCY_PATTERNS, "NileBank does not allow urgency framing around financial decisions."),
    brandRule("SE.4", "brand_violation", POLITICAL_NEWS_PATTERNS, "StayEasy allows no political or news-tied content."),
  ];

  for (const rule of rules) {
    if (!isCitable(guidelines, rule.clauseCode)) continue;
    if (!rule.matches(itemText, briefContext)) continue;
    return flag(rule.clauseCode, rule.flagType, rule.reason);
  }

  return ok(item);
}

function judgmentToOutcome(
  item: GeneratedPlanItem,
  judgment: ComplianceJudgment,
  guidelines: GuidelineBundle,
): Outcome<GeneratedPlanItem> {
  const decision = judgment.decision;
  if (decision === "DRAFT") {
    return ok(item);
  }

  const problems: string[] = [];
  const clauseCode = judgment.clause_code?.trim() ?? "";
  const flagType = judgment.flag_type;
  const validatedFlagType =
    flagType && COMPLIANCE_FLAG_TYPES.includes(flagType) ? flagType : null;

  if (decision !== "FLAG") {
    problems.push(`unsupported decision ${JSON.stringify(decision)}`);
  }
  if (!clauseCode) {
    problems.push("FLAG judgment has no clause_code");
  } else if (!isCitable(guidelines, clauseCode)) {
    problems.push(`FLAG judgment cites an unretrieved clause: ${clauseCode}`);
  }
  if (!validatedFlagType) {
    problems.push(`FLAG judgment has unsupported flag_type ${JSON.stringify(flagType)}`);
  }

  if (problems.length > 0) {
    throw new InvalidComplianceJudgmentError(problems);
  }

  return flag(
    clauseCode,
    validatedFlagType ?? "compliance_violation",
    judgment.reason?.trim() || `Generated item conflicts with clause ${clauseCode}.`,
  );
}

function contextFromAnalysis(analysis: BriefAnalysis | undefined): string {
  if (!analysis) return "";
  return [
    analysis.title,
    analysis.objective,
    analysis.audience,
    analysis.channels.join(", "),
    analysis.deliverables.map((d) => d.raw).join("; "),
    analysis.notes,
  ]
    .filter(Boolean)
    .join("\n");
}

function itemSurface(item: GeneratedPlanItem): string {
  return [
    item.title,
    item.content_body,
    item.rationale,
    item.clause_codes.join(", "),
  ]
    .filter(Boolean)
    .join("\n");
}

function hasCertification(text: string): boolean {
  if (/\b(?:no|without)\s+(?:organic\s+)?certif(?:ication|ied)?\b/i.test(text)) {
    return false;
  }
  if (/\b(?:not|isn['`]?t|aren['`]?t)\s+certified\b/i.test(text)) {
    return false;
  }
  if (/\buncertified\b/i.test(text)) {
    return false;
  }
  return /\bcertif(?:ied|ication)\b/i.test(text);
}

type Rule = {
  clauseCode: string;
  flagType: FlagType;
  reason: string;
  matches: (itemText: string, briefContext: string) => boolean;
};

function agencyRule(
  clauseCode: string,
  flagType: FlagType,
  patterns: RegExp[],
  reason: string,
): Rule {
  return {
    clauseCode,
    flagType,
    reason,
    matches: (text) => patterns.some((p) => p.test(text)),
  };
}

function brandRule(
  clauseCode: string,
  flagType: FlagType,
  patterns: RegExp[],
  reason: string,
  extra?: (itemText: string, briefContext: string) => boolean,
): Rule {
  return {
    clauseCode,
    flagType,
    reason,
    matches: (text, brief) =>
      patterns.some((p) => p.test(text)) && (extra ? extra(text, brief) : true),
  };
}

const DISCOUNT_PATTERNS = [
  /\bdiscounts?\b/i,
  /\bpromo\s*codes?\b/i,
  /\bcoupons?\b/i,
  /\bflash\s+sales?\b/i,
  /\bprice[-\s]?led\b/i,
  /\b\d{1,2}%\s*off\b/i,
];

const ORGANIC_PATTERNS = [/\borganic\b/i];

const MEDCARE_SYMPTOM_PATTERNS = [
  /\bsymptom\s+checklists?\b/i,
  /\bsigns\s+you\s+(?:might|may|could)\s+have\b/i,
  /\bdiagnos(?:e|is|tic)\b/i,
];

const HEALTH_CLAIM_PATTERNS = [
  /\b(?:treat|cure|prevent|diagnose|heal)s?\b/i,
  /\bweight[-\s]?loss\b/i,
  /\blose\s+(?:\d+\s*)?(?:kg|kilos?|pounds?|lbs?|weight)\b/i,
  /\bburn\s+fat\b/i,
  /\bsummer\s+body\b/i,
  /\bbefore[-/\s]?after\b/i,
  /\b(?:boosts?|strengthens?)\s+(?:your\s+)?immunity\b/i,
];

const GUARANTEE_PATTERNS = [
  /\bguarante(?:e|ed|es|eing)\b.{0,40}\b(?:returns?|results?|approvals?|rates?|sales?|growth|profits?)\b/i,
  /\b(?:double|triple)s?\s+(?:your\s+)?(?:sales|revenue|returns?|profits?)\b/i,
  /\bresults?\s+in\s+\d+\s+days?\b/i,
];

const PAID_DISCLOSURE_PATTERNS = [
  /\b(?:hide|skip|omit|without|no)\s+(?:the\s+)?(?:#?ad|#?gifted|disclosure|sponsored\s+tag)\b/i,
  /\b(?:paid\s+influencer|gifted\s+collab|gifted\s+post|sponsored\s+post)\b(?![\s\S]*(?:#ad|#gifted|paid partnership|sponsored partnership|clear disclosure))/i,
];

const POLITICAL_NEWS_PATTERNS = [
  /\b(?:election|parliament|president|minister|protest|political|campaign news|newsjack|news-tied)\b/i,
];

const COMPETITOR_MOCKERY_PATTERNS = [
  /\b(?:mock|attack|trash|drag|shame|slam)\b.{0,50}\b(?:competitor|brand|zara|h&m|shein)\b/i,
  /\b(?:competitor|brand|zara|h&m|shein)\b.{0,50}\b(?:mock|attack|trash|drag|shame|slam)\b/i,
];

const FINANCE_URGENCY_PATTERNS = [
  /\b(?:apply|invest|lock\s+in|open)\s+(?:now|today|tonight)\b/i,
  /\b(?:limited[-\s]?time|last chance|ends tonight)\b.{0,60}\b(?:loan|rate|return|approval|savings|investment)\b/i,
];

export { CLAUSE_SUPERLATIVE };
