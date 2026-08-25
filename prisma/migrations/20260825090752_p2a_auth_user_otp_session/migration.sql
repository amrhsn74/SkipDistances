-- Adds authentication to User, plus LoginOtp and Session.
--
-- `email` is required and unique, and the table already holds seeded demo users
-- with no email. Rather than dropping them, the backfill below derives the same
-- address prisma/seed.ts generates from a name -- lowercase, spaces to dots,
-- apostrophes and periods stripped -- so a migrated database and a freshly
-- seeded one agree.
--
-- Existing users are left `active` with a null password_hash: they cannot sign
-- in until the seed gives them one, which is the correct state for a row that
-- has never had a credential.

-- CreateTable
CREATE TABLE "LoginOtp" (
    "otp_id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "consumed_at" DATETIME,
    "created_by_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoginOtp_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("user_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LoginOtp_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "User" ("user_id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "session_id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "revoked_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User" ("user_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "user_id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "user_type" TEXT NOT NULL,
    "is_agency_admin" BOOLEAN NOT NULL DEFAULT false,
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_login_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_User" ("created_at", "is_agency_admin", "name", "user_id", "user_type", "email")
SELECT
    "created_at",
    "is_agency_admin",
    "name",
    "user_id",
    "user_type",
    replace(replace(replace(trim(lower("name")), '.', ''), '''', ''), ' ', '.') || '@skipstudio.test'
FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_user_type_idx" ON "User"("user_type");
CREATE INDEX "User_status_idx" ON "User"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "LoginOtp_user_id_consumed_at_idx" ON "LoginOtp"("user_id", "consumed_at");

-- CreateIndex
CREATE INDEX "LoginOtp_expires_at_idx" ON "LoginOtp"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_hash_key" ON "Session"("token_hash");

-- CreateIndex
CREATE INDEX "Session_user_id_idx" ON "Session"("user_id");

-- CreateIndex
CREATE INDEX "Session_expires_at_idx" ON "Session"("expires_at");
