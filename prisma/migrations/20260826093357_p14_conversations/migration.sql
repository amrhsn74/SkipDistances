-- CreateTable
CREATE TABLE "Conversation" (
    "conversation_id" TEXT NOT NULL PRIMARY KEY,
    "client_id" TEXT NOT NULL,
    "created_by_id" TEXT,
    "campaign_id" TEXT,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "Conversation_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client" ("client_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Conversation_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "User" ("user_id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Conversation_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "Campaign" ("campaign_id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConversationTurn" (
    "turn_id" TEXT NOT NULL PRIMARY KEY,
    "conversation_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "flag_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConversationTurn_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "Conversation" ("conversation_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ConversationTurn_flag_id_fkey" FOREIGN KEY ("flag_id") REFERENCES "Flag" ("flag_id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ReferenceAttachment" (
    "attachment_id" TEXT NOT NULL PRIMARY KEY,
    "content_item_id" TEXT NOT NULL,
    "turn_id" TEXT,
    "uploaded_by_id" TEXT,
    "file_type" TEXT NOT NULL,
    "storage_url" TEXT NOT NULL,
    "instruction" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReferenceAttachment_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "ContentItem" ("content_item_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReferenceAttachment_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "User" ("user_id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ReferenceAttachment_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "ConversationTurn" ("turn_id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ReferenceAttachment" ("attachment_id", "content_item_id", "created_at", "file_type", "instruction", "storage_url", "uploaded_by_id") SELECT "attachment_id", "content_item_id", "created_at", "file_type", "instruction", "storage_url", "uploaded_by_id" FROM "ReferenceAttachment";
DROP TABLE "ReferenceAttachment";
ALTER TABLE "new_ReferenceAttachment" RENAME TO "ReferenceAttachment";
CREATE INDEX "ReferenceAttachment_content_item_id_idx" ON "ReferenceAttachment"("content_item_id");
CREATE INDEX "ReferenceAttachment_turn_id_idx" ON "ReferenceAttachment"("turn_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Conversation_created_by_id_status_idx" ON "Conversation"("created_by_id", "status");

-- CreateIndex
CREATE INDEX "Conversation_client_id_idx" ON "Conversation"("client_id");

-- CreateIndex
CREATE INDEX "Conversation_campaign_id_idx" ON "Conversation"("campaign_id");

-- CreateIndex
CREATE INDEX "ConversationTurn_conversation_id_created_at_idx" ON "ConversationTurn"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "ConversationTurn_flag_id_idx" ON "ConversationTurn"("flag_id");
