import { prisma, type Db } from "../db";
import { TEMPERATURE, type GenerateOptions, generateStructured } from "../llm/gemini";
import type { BriefAnalysis } from "./analyzeBrief";
import {
  type CampaignCalendar,
  formatCalendarForPrompt,
} from "./resolveCalendar";
import {
  type GuidelineBundle,
  formatGuidelinesForPrompt,
  uncitableCodes,
} from "./searchGuidelines";

/**
 * Step 6: draft a multi-form content plan.
 *
 * This is the first pipeline step that is genuinely generative. It is still not
 * trusted. The model receives only the retrieved client-scoped clauses and the
 * resolved client-scoped calendar, then code validates the two values that would
 * break isolation if accepted blindly: markets and clause citations.
 */

export type DraftContentForm =
  | "post"
  | "image"
  | "video"
  | "reel"
  | "photoshoot"
  | "email"
  | "blog_post"
  | "ad_copy"
  | "hashtag_set"
  | "cta"
  | "creative_prompt";

export type GeneratedPlanItem = {
  title: string;
  content_form: DraftContentForm;
  platform: string | null;
  content_body: string | null;
  market_id: string | null;
  scheduled_date: Date | null;
  occasion_key: string | null;
  clause_codes: string[];
  rationale: string | null;
};

export type GeneratedPlan = {
  items: GeneratedPlanItem[];
  notes: string | null;
};

export type GeneratePlanInput = {
  client: {
    client_id: string;
    name: string;
    industry: string;
    channels: string[];
  };
  analysis: BriefAnalysis;
  calendar: CampaignCalendar;
  guidelines: GuidelineBundle;
};

type RawGeneratedPlanItem = {
  title: string;
  content_form: string;
  platform: string | null;
  content_body: string | null;
  market_id: string | null;
  scheduled_date: string | null;
  occasion_key: string | null;
  clause_codes: string[];
  rationale: string | null;
};

type RawGeneratedPlan = {
  items: RawGeneratedPlanItem[];
  notes: string | null;
};

export type StructuredGenerator = <T>(
  prompt: string,
  schema: object,
  options?: GenerateOptions,
) => Promise<T>;

export class InvalidGeneratedPlanError extends Error {
  readonly code = "INVALID_GENERATED_PLAN";
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Generated plan failed validation: ${problems.join("; ")}`);
    this.name = "InvalidGeneratedPlanError";
    this.problems = problems;
  }
}

const CONTENT_FORMS: DraftContentForm[] = [
  "post",
  "image",
  "video",
  "reel",
  "photoshoot",
  "email",
  "blog_post",
  "ad_copy",
  "hashtag_set",
  "cta",
  "creative_prompt",
];

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          content_form: { type: "string" },
          platform: { type: "string", nullable: true },
          content_body: { type: "string", nullable: true },
          market_id: { type: "string", nullable: true },
          scheduled_date: { type: "string", nullable: true },
          occasion_key: { type: "string", nullable: true },
          clause_codes: { type: "array", items: { type: "string" } },
          rationale: { type: "string", nullable: true },
        },
        required: ["title", "content_form", "market_id", "scheduled_date", "clause_codes"],
      },
    },
    notes: { type: "string", nullable: true },
  },
  required: ["items"],
} as const;

const SYSTEM_INSTRUCTION = `You draft content plans for Skip Studio.

Use only the brief, calendar and clauses provided in the user message. Return
JSON only. Every item must cite the clause codes that justify it; cite codes as
shown, for example 0.6 or CR.4. The market_id field must be null for evergreen
or all-market shared content, or exactly one of the listed market ids for
market-specific content.`;

/**
 * Draft a plan and validate the model-scoped fields against database facts.
 */
export async function generatePlan(
  input: GeneratePlanInput,
  db: Db = prisma,
  generator: StructuredGenerator = generateStructured,
): Promise<GeneratedPlan> {
  const markets = await getClientMarkets(input.client.client_id, db);
  const marketNames = Object.fromEntries(markets.map((m) => [m.market_id, m.name]));

  const raw = await generator<RawGeneratedPlan>(
    buildGeneratePlanPrompt(input, markets),
    PLAN_SCHEMA,
    {
      temperature: TEMPERATURE.creative,
      systemInstruction: SYSTEM_INSTRUCTION,
      maxOutputTokens: 8192,
    },
  );

  return normalizeGeneratedPlan(raw, input.guidelines, new Set(markets.map((m) => m.market_id)), marketNames);
}

type ClientMarketPromptRow = {
  market_id: string;
  name: string;
  country_code: string;
};

async function getClientMarkets(
  clientId: string,
  db: Db,
): Promise<ClientMarketPromptRow[]> {
  const rows = await db.clientMarket.findMany({
    where: { client_id: clientId },
    select: {
      market: {
        select: {
          market_id: true,
          name: true,
          country_code: true,
        },
      },
    },
    orderBy: { market_id: "asc" },
  });

  return rows.map((r) => r.market);
}

export function buildGeneratePlanPrompt(
  input: GeneratePlanInput,
  markets: ClientMarketPromptRow[],
): string {
  const marketNames = Object.fromEntries(markets.map((m) => [m.market_id, m.name]));

  return `Draft a multi-form content plan for this client.

Client:
${JSON.stringify(
  {
    client_id: input.client.client_id,
    name: input.client.name,
    industry: input.client.industry,
    channels: input.client.channels,
    markets,
  },
  null,
  2,
)}

Extracted brief:
${JSON.stringify(input.analysis, null, 2)}

Requested deliverables:
${input.analysis.deliverables.map((d) => `- ${d.quantity ?? "unspecified"} ${d.kind}: ${d.raw}`).join("\n")}

Calendar:
${formatCalendarForPrompt(input.calendar, marketNames)}

Guidelines:
${formatGuidelinesForPrompt(input.guidelines)}

Output requirements:
- Produce one item per requested deliverable. If a deliverable asks for a count,
  produce that many items.
- Include post, image, video, reel and photoshoot forms when requested; do not
  collapse different forms into one caption.
- For evergreen or shared all-market content, set market_id to null.
- For market-specific occasion content, set market_id to the exact market_id
  listed above and schedule against that market's date from the calendar.
- Every item must cite at least one retrieved clause code in clause_codes.
- Do not cite omitted, guessed or other-client clauses.`;
}

export function normalizeGeneratedPlan(
  raw: RawGeneratedPlan,
  guidelines: GuidelineBundle,
  allowedMarketIds: Set<string>,
  marketNames: Record<string, string> = {},
): GeneratedPlan {
  const problems: string[] = [];

  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    problems.push("the plan returned no items");
  }

  const items = (raw.items ?? []).map((item, index) => {
    const label = `item ${index + 1}`;
    const contentForm = normalizeContentForm(item.content_form);
    const marketId = normalizeNullableString(item.market_id);
    const clauseCodes = uniqueStrings(item.clause_codes ?? []);

    if (!contentForm) {
      problems.push(`${label} has unsupported content_form ${JSON.stringify(item.content_form)}`);
    }

    if (marketId && !allowedMarketIds.has(marketId)) {
      const named = marketNames[marketId] ? ` (${marketNames[marketId]})` : "";
      problems.push(`${label} cites market ${marketId}${named}, which this client does not operate in`);
    }

    if (clauseCodes.length === 0) {
      problems.push(`${label} cites no clauses`);
    } else {
      const uncitable = uncitableCodes(guidelines, clauseCodes);
      if (uncitable.length > 0) {
        problems.push(`${label} cites clauses that were not retrieved: ${uncitable.join(", ")}`);
      }
    }

    const scheduledDate = normalizeDate(item.scheduled_date);
    if (item.scheduled_date && !scheduledDate) {
      problems.push(`${label} has an invalid scheduled_date ${JSON.stringify(item.scheduled_date)}`);
    }

    return {
      title: item.title?.trim() || "Untitled draft",
      content_form: contentForm ?? "post",
      platform: normalizeNullableString(item.platform),
      content_body: normalizeNullableString(item.content_body),
      market_id: marketId,
      scheduled_date: scheduledDate,
      occasion_key: normalizeNullableString(item.occasion_key),
      clause_codes: clauseCodes,
      rationale: normalizeNullableString(item.rationale),
    };
  });

  if (problems.length > 0) {
    throw new InvalidGeneratedPlanError(problems);
  }

  return {
    items,
    notes: normalizeNullableString(raw.notes),
  };
}

function normalizeContentForm(value: string): DraftContentForm | null {
  const normalized = value?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return CONTENT_FORMS.includes(normalized as DraftContentForm)
    ? (normalized as DraftContentForm)
    : null;
}

function normalizeNullableString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function normalizeDate(value: string | null | undefined): Date | null {
  const normalized = normalizeNullableString(value);
  if (!normalized) return null;

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;

  return parsed;
}
