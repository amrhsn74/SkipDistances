-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Client" (
    "client_id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "tier" TEXT,
    "channels" TEXT NOT NULL,
    "account_manager_id" TEXT,
    "active_brand_guide_id" TEXT,
    "sensitive_sector" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "Client_account_manager_id_fkey" FOREIGN KEY ("account_manager_id") REFERENCES "User" ("user_id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Client" ("account_manager_id", "active_brand_guide_id", "channels", "client_id", "created_at", "industry", "name", "status", "tier", "updated_at") SELECT "account_manager_id", "active_brand_guide_id", "channels", "client_id", "created_at", "industry", "name", "status", "tier", "updated_at" FROM "Client";
DROP TABLE "Client";
ALTER TABLE "new_Client" RENAME TO "Client";
CREATE INDEX "Client_status_idx" ON "Client"("status");
CREATE INDEX "Client_account_manager_id_idx" ON "Client"("account_manager_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
