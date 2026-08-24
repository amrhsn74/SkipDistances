-- CreateTable
CREATE TABLE "Campaign" (
    "campaign_id" TEXT NOT NULL PRIMARY KEY,
    "client_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "objective" TEXT,
    "audience" TEXT,
    "channels" TEXT,
    "raw_brief_text" TEXT NOT NULL,
    "related_occasion_id" TEXT,
    "submitted_by_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "override_attempt_detected" BOOLEAN NOT NULL DEFAULT false,
    "compliance_review_required" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "Campaign_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client" ("client_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Campaign_related_occasion_id_fkey" FOREIGN KEY ("related_occasion_id") REFERENCES "Occasion" ("occasion_id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Campaign_submitted_by_id_fkey" FOREIGN KEY ("submitted_by_id") REFERENCES "User" ("user_id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ContentItem" (
    "content_item_id" TEXT NOT NULL PRIMARY KEY,
    "campaign_id" TEXT NOT NULL,
    "content_form" TEXT NOT NULL,
    "platform" TEXT,
    "content_body" TEXT,
    "market_id" TEXT,
    "scheduled_date" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'drafted',
    "flagged_clause_id" TEXT,
    "parent_content_item_id" TEXT,
    "grounded_brand_guide_version_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "ContentItem_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "Campaign" ("campaign_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ContentItem_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "Market" ("market_id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ContentItem_parent_content_item_id_fkey" FOREIGN KEY ("parent_content_item_id") REFERENCES "ContentItem" ("content_item_id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ContentItemCitation" (
    "citation_id" TEXT NOT NULL PRIMARY KEY,
    "content_item_id" TEXT NOT NULL,
    "clause_id" TEXT NOT NULL,
    CONSTRAINT "ContentItemCitation_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "ContentItem" ("content_item_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "media_asset_id" TEXT NOT NULL PRIMARY KEY,
    "content_item_id" TEXT NOT NULL,
    "asset_type" TEXT NOT NULL,
    "generation_source" TEXT NOT NULL,
    "storage_url" TEXT NOT NULL,
    "format" TEXT,
    "created_by_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MediaAsset_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "ContentItem" ("content_item_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MediaAsset_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "User" ("user_id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReferenceAttachment" (
    "attachment_id" TEXT NOT NULL PRIMARY KEY,
    "content_item_id" TEXT NOT NULL,
    "uploaded_by_id" TEXT,
    "file_type" TEXT NOT NULL,
    "storage_url" TEXT NOT NULL,
    "instruction" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReferenceAttachment_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "ContentItem" ("content_item_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReferenceAttachment_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "User" ("user_id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Approval" (
    "approval_id" TEXT NOT NULL PRIMARY KEY,
    "content_item_id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "decided_by_id" TEXT,
    "decided_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bulk_action_id" TEXT,
    CONSTRAINT "Approval_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "User" ("user_id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Flag" (
    "flag_id" TEXT NOT NULL PRIMARY KEY,
    "campaign_id" TEXT,
    "content_item_id" TEXT,
    "clause_id" TEXT,
    "flag_type" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolution_notes" TEXT,
    "resolved_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Flag_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "Campaign" ("campaign_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "audit_id" TEXT NOT NULL PRIMARY KEY,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" TEXT,
    "performed_by_id" TEXT,
    "performed_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_performed_by_id_fkey" FOREIGN KEY ("performed_by_id") REFERENCES "User" ("user_id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Campaign_client_id_status_idx" ON "Campaign"("client_id", "status");

-- CreateIndex
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- CreateIndex
CREATE INDEX "ContentItem_campaign_id_status_idx" ON "ContentItem"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "ContentItem_status_scheduled_date_idx" ON "ContentItem"("status", "scheduled_date");

-- CreateIndex
CREATE INDEX "ContentItem_market_id_idx" ON "ContentItem"("market_id");

-- CreateIndex
CREATE INDEX "ContentItemCitation_content_item_id_idx" ON "ContentItemCitation"("content_item_id");

-- CreateIndex
CREATE INDEX "ContentItemCitation_clause_id_idx" ON "ContentItemCitation"("clause_id");

-- CreateIndex
CREATE UNIQUE INDEX "ContentItemCitation_content_item_id_clause_id_key" ON "ContentItemCitation"("content_item_id", "clause_id");

-- CreateIndex
CREATE INDEX "MediaAsset_content_item_id_idx" ON "MediaAsset"("content_item_id");

-- CreateIndex
CREATE INDEX "ReferenceAttachment_content_item_id_idx" ON "ReferenceAttachment"("content_item_id");

-- CreateIndex
CREATE INDEX "Approval_content_item_id_stage_decided_at_idx" ON "Approval"("content_item_id", "stage", "decided_at");

-- CreateIndex
CREATE INDEX "Approval_bulk_action_id_idx" ON "Approval"("bulk_action_id");

-- CreateIndex
CREATE INDEX "Flag_campaign_id_idx" ON "Flag"("campaign_id");

-- CreateIndex
CREATE INDEX "Flag_content_item_id_idx" ON "Flag"("content_item_id");

-- CreateIndex
CREATE INDEX "Flag_resolved_idx" ON "Flag"("resolved");

-- CreateIndex
CREATE INDEX "AuditLog_entity_type_entity_id_idx" ON "AuditLog"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "AuditLog_performed_at_idx" ON "AuditLog"("performed_at");
