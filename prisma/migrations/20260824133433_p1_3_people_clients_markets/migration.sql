-- CreateTable
CREATE TABLE "User" (
    "user_id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "user_type" TEXT NOT NULL,
    "is_agency_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ClientAssignment" (
    "assignment_id" TEXT NOT NULL PRIMARY KEY,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role_on_client" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientAssignment_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client" ("client_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClientAssignment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Client" (
    "client_id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "tier" TEXT,
    "channels" TEXT NOT NULL,
    "account_manager_id" TEXT,
    "active_brand_guide_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "Client_account_manager_id_fkey" FOREIGN KEY ("account_manager_id") REFERENCES "User" ("user_id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Market" (
    "market_id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "country_code" TEXT NOT NULL,
    "calendar_system" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "ClientMarket" (
    "client_market_id" TEXT NOT NULL PRIMARY KEY,
    "client_id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    CONSTRAINT "ClientMarket_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client" ("client_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClientMarket_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "Market" ("market_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "User_user_type_idx" ON "User"("user_type");

-- CreateIndex
CREATE INDEX "ClientAssignment_client_id_idx" ON "ClientAssignment"("client_id");

-- CreateIndex
CREATE INDEX "ClientAssignment_user_id_idx" ON "ClientAssignment"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ClientAssignment_client_id_user_id_role_on_client_key" ON "ClientAssignment"("client_id", "user_id", "role_on_client");

-- CreateIndex
CREATE INDEX "Client_status_idx" ON "Client"("status");

-- CreateIndex
CREATE INDEX "Client_account_manager_id_idx" ON "Client"("account_manager_id");

-- CreateIndex
CREATE UNIQUE INDEX "Market_name_key" ON "Market"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Market_country_code_key" ON "Market"("country_code");

-- CreateIndex
CREATE INDEX "ClientMarket_client_id_idx" ON "ClientMarket"("client_id");

-- CreateIndex
CREATE INDEX "ClientMarket_market_id_idx" ON "ClientMarket"("market_id");

-- CreateIndex
CREATE UNIQUE INDEX "ClientMarket_client_id_market_id_key" ON "ClientMarket"("client_id", "market_id");
