-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Flag" (
    "flag_id" TEXT NOT NULL PRIMARY KEY,
    "campaign_id" TEXT,
    "content_item_id" TEXT,
    "clause_id" TEXT,
    "flag_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'high',
    "raised_against_id" TEXT,
    "details" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolution_notes" TEXT,
    "resolved_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Flag_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "Campaign" ("campaign_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Flag_raised_against_id_fkey" FOREIGN KEY ("raised_against_id") REFERENCES "User" ("user_id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Flag" ("campaign_id", "clause_id", "content_item_id", "created_at", "flag_id", "flag_type", "resolution_notes", "resolved", "resolved_at") SELECT "campaign_id", "clause_id", "content_item_id", "created_at", "flag_id", "flag_type", "resolution_notes", "resolved", "resolved_at" FROM "Flag";
DROP TABLE "Flag";
ALTER TABLE "new_Flag" RENAME TO "Flag";
CREATE INDEX "Flag_campaign_id_idx" ON "Flag"("campaign_id");
CREATE INDEX "Flag_content_item_id_idx" ON "Flag"("content_item_id");
CREATE INDEX "Flag_resolved_idx" ON "Flag"("resolved");
CREATE INDEX "Flag_raised_against_id_idx" ON "Flag"("raised_against_id");
CREATE INDEX "Flag_resolved_severity_idx" ON "Flag"("resolved", "severity");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
