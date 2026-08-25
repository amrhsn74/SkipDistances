import { readFile } from "node:fs/promises";
import { prisma, type Db } from "../db";
import { writeAudit } from "../domain/auditLog";
import { isOk } from "../domain/decision";
import { resolveClient } from "../domain/clientResolution";
import { applyTransition, type ContentStatus } from "../domain/statusMachine";
import {
  complianceCheck,
  judgeWithGemini,
  type ComplianceJudge,
  type ItemComplianceResult,
} from "./complianceCheck";
import { generatePlan, type GeneratedPlanItem } from "./generatePlan";
import { searchGuidelines } from "./searchGuidelines";

export type RegenerationReference = {
  attachment_id: string;
  content_item_id: string;
  file_type: string;
  storage_url: string;
  instruction: string | null;
};

export type RegenerateItemInput = {
  prompt: string;
  references?: RegenerationReference[];
};

export type RegenerateItemDependencies = {
  generate: typeof generatePlan;
  judge: ComplianceJudge;
};

const defaultDependencies: RegenerateItemDependencies = {
  generate: generatePlan,
  judge: judgeWithGemini,
};

export type RegenerateItemResult = {
  contentItemId: string;
  item: GeneratedPlanItem;
  compliance: ItemComplianceResult;
  status: ContentStatus;
  referenceIds: string[];
};

export class RegenerateItemError extends Error {
  readonly code = "REGENERATE_ITEM_ERROR";
}

/** Regenerate one existing item under its client's current retrieved rules. */
export async function regenerateItem(
  contentItemId: string,
  input: RegenerateItemInput,
  db: Db = prisma,
  dependencies: RegenerateItemDependencies = defaultDependencies,
): Promise<RegenerateItemResult> {
  const existing = await db.contentItem.findUnique({
    where: { content_item_id: contentItemId },
    include: { campaign: true, references: true },
  });
  if (!existing) throw new RegenerateItemError(`Content item ${contentItemId} does not exist.`);

  const references = input.references ?? existing.references;
  if (references.some((reference) => reference.content_item_id !== contentItemId)) {
    throw new RegenerateItemError("A reference belongs to a different content item.");
  }

  const clientOutcome = await resolveClient(existing.campaign.client_id, db);
  if (!isOk(clientOutcome)) {
    throw new RegenerateItemError(`Cannot regenerate for ${existing.campaign.client_id}.`);
  }

  const guidelines = await searchGuidelines(existing.campaign.client_id, db);
  const referenceMaterial = await loadReferences(references);
  const analysis = {
    client_reference: existing.campaign.client_id,
    client_id: existing.campaign.client_id,
    title: existing.campaign.title,
    objective: existing.campaign.objective,
    audience: existing.campaign.audience,
    channels: parseChannels(existing.campaign.channels),
    deliverables: [{ kind: existing.content_form, quantity: 1, raw: existing.content_form }],
    notes: [input.prompt, referenceMaterial.text].filter(Boolean).join("\n\n") || null,
    date: existing.scheduled_date?.toISOString() ?? null,
    explicitly_missing: [],
  };

  const plan = await dependencies.generate(
    {
      client: clientOutcome.value,
      analysis,
      guidelines,
      calendar: {
        clientId: existing.campaign.client_id,
        window: { from: new Date(0), to: new Date(0) },
        occasions: [],
        shared: [],
        perMarket: [],
      },
      referenceContext: referenceMaterial.text,
      imageBase64: referenceMaterial.imageBase64,
      imageMimeType: referenceMaterial.imageMimeType,
    },
    db,
  );

  if (plan.items.length !== 1) {
    throw new RegenerateItemError("Regeneration must return exactly one content item.");
  }

  const [compliance] = await complianceCheck(
    { plan: { items: plan.items, notes: plan.notes }, guidelines, briefContext: input.prompt },
    dependencies.judge,
  );
  if (compliance.outcome.decision !== "DRAFT") {
    return {
      contentItemId,
      item: compliance.item,
      compliance,
      status: existing.status as ContentStatus,
      referenceIds: references.map((reference) => reference.attachment_id),
    };
  }

  const transition = applyTransition(existing.status as ContentStatus, { cause: "content_edit" });
  if (!transition.ok) throw new RegenerateItemError(transition.reason ?? "Item cannot be regenerated.");

  const run = (tx: Db) => persistRegeneration(contentItemId, existing, compliance, transition.status, references, guidelines, tx);
  return hasTransaction(db) ? db.$transaction(run) : run(db);
}

async function persistRegeneration(
  contentItemId: string,
  existing: { status: string },
  compliance: ItemComplianceResult,
  status: ContentStatus,
  references: RegenerationReference[],
  guidelines: Awaited<ReturnType<typeof searchGuidelines>>,
  db: Db,
): Promise<RegenerateItemResult> {
  const item = compliance.item;
  const citationIds = [...new Set(item.clause_codes.map((code) => guidelines.all.find((clause) => clause.clause_code === code)?.clause_id).filter((id): id is string => Boolean(id)))];
  await db.contentItem.update({
    where: { content_item_id: contentItemId },
    data: {
      content_form: item.content_form,
      platform: item.platform,
      content_body: item.content_body,
      market_id: item.market_id,
      scheduled_date: item.scheduled_date,
      status,
      flagged_clause_id: null,
    },
  });
  await db.contentItemCitation.deleteMany({ where: { content_item_id: contentItemId } });
  if (citationIds.length > 0) {
    await db.contentItemCitation.createMany({
      data: citationIds.map((clause_id) => ({ content_item_id: contentItemId, clause_id })),
    });
  }
  await writeAudit({
    entityType: "ContentItem",
    entityId: contentItemId,
    action: "edited",
    details: { from_status: existing.status, to_status: status, reference_ids: references.map((reference) => reference.attachment_id) },
  }, db);
  return {
    contentItemId,
    item,
    compliance,
    status,
    referenceIds: references.map((reference) => reference.attachment_id),
  };
}

async function loadReferences(references: RegenerationReference[]) {
  let text = "";
  let imageBase64: string | undefined;
  let imageMimeType: string | undefined;
  for (const reference of references) {
    if (reference.file_type === "image" && !imageBase64) {
      imageBase64 = (await readFile(reference.storage_url)).toString("base64");
      imageMimeType = mimeType(reference.storage_url);
    } else if (reference.file_type === "pdf" || reference.file_type === "doc") {
      const extracted = await readFile(reference.storage_url, "utf8");
      text += `\n[${reference.file_type}] ${reference.instruction ?? ""}\n${extracted}`;
    }
    if (reference.instruction && reference.file_type === "image") text += `\n[image] ${reference.instruction}`;
  }
  return { text: text.trim(), imageBase64, imageMimeType };
}

function parseChannels(value: string | null): string[] {
  if (!value) return [];
  try { return JSON.parse(value) as string[]; } catch { return [value]; }
}

function mimeType(path: string): string {
  return path.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
}

function hasTransaction(db: Db): db is typeof prisma {
  return "$transaction" in db;
}