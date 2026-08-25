import { prisma, type Db } from "../db";
import { writeAudit } from "../domain/auditLog";
import { isOk, type Outcome, type RequestInfo } from "../domain/decision";
import { raiseFlag } from "../domain/misuse";
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

export type PersistedFlag = PersistedDraft & {
  flagId: string;
  clauseId: string;
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

    const createdFlag = await raiseFlag(
      {
        flagType: flaggedOutcome.flagType,
        campaignId: input.campaignId,
        contentItemId: contentItem.content_item_id,
        clauseId: flaggedClauseId,
        details: {
          clause_code: flaggedOutcome.clauseCode,
          reason: flaggedOutcome.reason,
          source: result.source,
          item_title: result.item.title,
        },
      },
      db,
    );

    flagged.push({
      ...base,
      flagId: createdFlag.flag_id,
      clauseId: flaggedClauseId,
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
