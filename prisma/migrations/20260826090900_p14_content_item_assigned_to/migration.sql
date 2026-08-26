-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ContentItem" (
    "content_item_id" TEXT NOT NULL PRIMARY KEY,
    "campaign_id" TEXT NOT NULL,
    "content_form" TEXT NOT NULL,
    "platform" TEXT,
    "content_body" TEXT,
    "market_id" TEXT,
    "scheduled_date" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'drafted',
    "flagged_clause_id" TEXT,
    "assigned_to_id" TEXT,
    "parent_content_item_id" TEXT,
    "grounded_brand_guide_version_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "ContentItem_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "Campaign" ("campaign_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ContentItem_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "Market" ("market_id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ContentItem_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "User" ("user_id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ContentItem_parent_content_item_id_fkey" FOREIGN KEY ("parent_content_item_id") REFERENCES "ContentItem" ("content_item_id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ContentItem" ("campaign_id", "content_body", "content_form", "content_item_id", "created_at", "flagged_clause_id", "grounded_brand_guide_version_id", "market_id", "parent_content_item_id", "platform", "scheduled_date", "status", "updated_at") SELECT "campaign_id", "content_body", "content_form", "content_item_id", "created_at", "flagged_clause_id", "grounded_brand_guide_version_id", "market_id", "parent_content_item_id", "platform", "scheduled_date", "status", "updated_at" FROM "ContentItem";
DROP TABLE "ContentItem";
ALTER TABLE "new_ContentItem" RENAME TO "ContentItem";
CREATE INDEX "ContentItem_campaign_id_status_idx" ON "ContentItem"("campaign_id", "status");
CREATE INDEX "ContentItem_status_scheduled_date_idx" ON "ContentItem"("status", "scheduled_date");
CREATE INDEX "ContentItem_market_id_idx" ON "ContentItem"("market_id");
CREATE INDEX "ContentItem_assigned_to_id_status_idx" ON "ContentItem"("assigned_to_id", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
