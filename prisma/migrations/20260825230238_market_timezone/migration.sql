-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Market" (
    "market_id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "calendar_system" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Cairo'
);
INSERT INTO "new_Market" ("calendar_system", "country_code", "market_id", "name") SELECT "calendar_system", "country_code", "market_id", "name" FROM "Market";
DROP TABLE "Market";
ALTER TABLE "new_Market" RENAME TO "Market";
CREATE UNIQUE INDEX "Market_name_key" ON "Market"("name");
CREATE UNIQUE INDEX "Market_country_code_key" ON "Market"("country_code");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
