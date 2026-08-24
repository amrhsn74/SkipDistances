-- CreateTable
CREATE TABLE "BrandGuideVersion" (
    "brand_guide_version_id" TEXT NOT NULL PRIMARY KEY,
    "client_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "created_by_id" TEXT,
    "client_approved_by_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" DATETIME,
    CONSTRAINT "BrandGuideVersion_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client" ("client_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GuidelineClause" (
    "clause_id" TEXT NOT NULL PRIMARY KEY,
    "source_type" TEXT NOT NULL,
    "brand_guide_version_id" TEXT,
    "clause_code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    CONSTRAINT "GuidelineClause_brand_guide_version_id_fkey" FOREIGN KEY ("brand_guide_version_id") REFERENCES "BrandGuideVersion" ("brand_guide_version_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Occasion" (
    "occasion_id" TEXT NOT NULL PRIMARY KEY,
    "market_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "date_type" TEXT NOT NULL,
    "month" INTEGER,
    "day" INTEGER,
    "shared_key" TEXT,
    CONSTRAINT "Occasion_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "Market" ("market_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OccasionDate" (
    "occasion_date_id" TEXT NOT NULL PRIMARY KEY,
    "occasion_id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "gregorian_date" DATETIME NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'seeded',
    CONSTRAINT "OccasionDate_occasion_id_fkey" FOREIGN KEY ("occasion_id") REFERENCES "Occasion" ("occasion_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BrandGuideVersion_client_id_status_idx" ON "BrandGuideVersion"("client_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BrandGuideVersion_client_id_version_number_key" ON "BrandGuideVersion"("client_id", "version_number");

-- CreateIndex
CREATE INDEX "GuidelineClause_source_type_idx" ON "GuidelineClause"("source_type");

-- CreateIndex
CREATE INDEX "GuidelineClause_clause_code_idx" ON "GuidelineClause"("clause_code");

-- CreateIndex
CREATE UNIQUE INDEX "GuidelineClause_brand_guide_version_id_clause_code_key" ON "GuidelineClause"("brand_guide_version_id", "clause_code");

-- CreateIndex
CREATE INDEX "Occasion_market_id_idx" ON "Occasion"("market_id");

-- CreateIndex
CREATE INDEX "Occasion_shared_key_idx" ON "Occasion"("shared_key");

-- CreateIndex
CREATE INDEX "OccasionDate_year_idx" ON "OccasionDate"("year");

-- CreateIndex
CREATE UNIQUE INDEX "OccasionDate_occasion_id_year_key" ON "OccasionDate"("occasion_id", "year");
