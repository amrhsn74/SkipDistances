import { prisma, type Db } from "../db";
import { writeAudit } from "../domain/auditLog";
import { isOk, type Outcome, type RequestInfo } from "../domain/decision";
import { requiresComplianceReview } from "../domain/sensitiveSector";
import type { GeneratedPlanItem } from "./generatePlan";
import type { ItemComplianceResult } from "./complianceCheck";
import type { GuidelineBundle } from "./searchGuidelines";

/**
 * Step 8: persist checked output.
 *
 * Generation and compliance only propose. This is where proposals become rows:
 * drafted items enter the review queue, flagged items are saved with a human
 * routing row, and item-level request-info outcomes hold the campaign without
 * inventing a draft or misusing the Flag table.
 */

export type QueueOrFlagInput = {
  campaignId: string;
  client: {
    client_id: string;
    industry: string;
    active_brand_guide_id?: string | null;
  };
  guidelines: GuidelineBundle;
  results: ItemComplianceResult[];
};

export type PersistedDraft = {
  contentItemId: string;
  item: GeneratedPlanItem;
  citationClauseIds: string[];
};

/**
 * An item the engine declined to draft.
 *
 * Carries no `flagId`: a content violation does not raise a governance row at
 * drafting time. See the comment at the push site below -- the row is raised on
 * submission, if the creator stands behind the item.
 */
export type PersistedFlag = PersistedDraft & {
  clauseId: string;
  clauseCode: string;
  flagType: string;
  reason: string | null;
};

export type HeldRequestInfo = {
  item: GeneratedPlanItem;
  outcome: RequestInfo;
};

export type QueueOrFlagResult = {
  campaignId: string;
  campaignStatus: "in_progress" | "info_requested";
  complianceReviewRequired: boolean;
  drafted: PersistedDraft[];
  flagged: PersistedFlag[];
  requestInfo: HeldRequestInfo[];
};

export class QueueOrFlagError extends Error {
  readonly code = "QUEUE_OR_FLAG_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "QueueOrFlagError";
  }
}

/**
 * Persist generated items and content flags in one transaction.
 */
export async function queueOrFlag(
  input: QueueOrFlagInput,
  db: Db = prisma,
): Promise<QueueOrFlagResult> {
  const run = (tx: Db) => persistQueueOrFlag(input, tx);
  return hasTransaction(db) ? db.$transaction(run) : run(db);
}

async function persistQueueOrFlag(
  input: QueueOrFlagInput,
  db: Db,
): Promise<QueueOrFlagResult> {
  const campaign = await db.campaign.findUnique({
    where: { campaign_id: input.campaignId },
    select: {
      campaign_id: true,
      client_id: true,
      status: true,
      compliance_review_required: true,
    },
  });

  if (!campaign) {
    throw new QueueOrFlagError(`Campaign ${input.campaignId} does not exist.`);
  }
  if (campaign.client_id !== input.client.client_id) {
    throw new QueueOrFlagError(
      `Campaign ${input.campaignId} belongs to ${campaign.client_id}, not ${input.client.client_id}.`,
    );
  }

  const complianceReviewRequired = requiresComplianceReview(input.client.industry);
  const requestInfo = requestInfoResults(input.results);
  const campaignStatus = requestInfo.length > 0 ? "info_requested" : "in_progress";

  await db.campaign.update({
    where: { campaign_id: input.campaignId },
    data: {
      compliance_review_required: complianceReviewRequired,
      status: campaignStatus,
    },
  });

  if (
    campaign.status !== campaignStatus ||
    campaign.compliance_review_required !== complianceReviewRequired
  ) {
    await writeAudit(
      {
        entityType: "Campaign",
        entityId: input.campaignId,
        action: "edited",
        performedById: null,
        details: {
          from_status: campaign.status,
          to_status: campaignStatus,
          compliance_review_required: complianceReviewRequired,
        },
      },
      db,
    );
  }

  const drafted: PersistedDraft[] = [];
  const flagged: PersistedFlag[] = [];

  for (const result of input.results) {
    if (result.outcome.decision === "REQUEST_INFO") continue;

    if (!isOk(result.outcome) && result.outcome.decision !== "FLAG") {
      throw new QueueOrFlagError(
        `${result.outcome.decision} is not a queueable item outcome.`,
      );
    }

    const flaggedOutcome = result.outcome.decision === "FLAG" ? result.outcome : null;
    const status = flaggedOutcome ? "flagged" : "drafted";
    const flaggedClauseId = flaggedOutcome
      ? clauseIdForCode(input.guidelines, flaggedOutcome.clauseCode)
      : null;

    const contentItem = await db.contentItem.create({
      data: {
        campaign_id: input.campaignId,
        content_form: result.item.content_form,
        platform: result.item.platform,
        content_body: result.item.content_body,
        market_id: result.item.market_id,
        scheduled_date: result.item.scheduled_date,
        status,
        flagged_clause_id: flaggedClauseId,
        grounded_brand_guide_version_id: input.guidelines.brandGuideVersionId,
      },
    });

    const citationClauseIds = citationIdsForItem(input.guidelines, result.item);
    if (citationClauseIds.length > 0) {
      await db.contentItemCitation.createMany({
        data: citationClauseIds.map((clauseId) => ({
          content_item_id: contentItem.content_item_id,
          clause_id: clauseId,
        })),
      });
    }

    await writeAudit(
      {
        entityType: "ContentItem",
        entityId: contentItem.content_item_id,
        action: "created",
        performedById: null,
        details: {
          campaign_id: input.campaignId,
          content_form: result.item.content_form,
          status,
          clause_codes: result.item.clause_codes,
        },
      },
      db,
    );

    const base = {
      contentItemId: contentItem.content_item_id,
      item: result.item,
      citationClauseIds,
    };

    if (!flaggedOutcome) {
      drafted.push(base);
      continue;
    }

    if (!flaggedClauseId) {
      throw new QueueOrFlagError("Flagged item has no resolved flagged clause.");
    }

    // No `Flag` row here, deliberately.
    //
    // A guideline violation caught at drafting is the engine doing its job: it
    // declined to write something, and the person who asked is told why. Raising
    // a governance row for it filled the Admin's evidence table with work nobody
    // had stood behind -- a creator exploring an idea, seeing the refusal, and
    // moving on would leave a permanent flag against a draft that never went
    // anywhere.
    //
    // Nothing is lost. The item is persisted as `flagged` and carries
    // `flagged_clause_id`, which is what the chat and the creator's queue read
    // to explain the refusal. The row is raised in `submitForReview` if and when
    // the creator actually submits the item -- at that point they have stood
    // behind it, and the Admin has something worth keeping.
    //
    // Misuse is the opposite case and is untouched: an override attempt or an
    // off-task prompt is flagged the moment it happens, because the act is the
    // evidence and waiting for a submission would lose it.
    flagged.push({
      ...base,
      clauseId: flaggedClauseId,
      clauseCode: flaggedOutcome.clauseCode,
      flagType: flaggedOutcome.flagType,
      reason: flaggedOutcome.reason,
    });
  }

  return {
    campaignId: input.campaignId,
    campaignStatus,
    complianceReviewRequired,
    drafted,
    flagged,
    requestInfo,
  };
}

function requestInfoResults(results: ItemComplianceResult[]): HeldRequestInfo[] {
  return results.flatMap((result) =>
    result.outcome.decision === "REQUEST_INFO"
      ? [{ item: result.item, outcome: result.outcome }]
      : [],
  );
}

function citationIdsForItem(
  guidelines: GuidelineBundle,
  item: GeneratedPlanItem,
): string[] {
  return [...new Set(item.clause_codes.map((code) => clauseIdForCode(guidelines, code)))];
}

function clauseIdForCode(guidelines: GuidelineBundle, clauseCode: string): string {
  const clause = guidelines.all.find((c) => c.clause_code === clauseCode);
  if (!clause) {
    throw new QueueOrFlagError(
      `Clause ${clauseCode} was not retrieved for client ${guidelines.clientId}.`,
    );
  }
  return clause.clause_id;
}

function hasTransaction(db: Db): db is typeof prisma {
  return "$transaction" in db;
}
