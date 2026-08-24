-- CreateTable
CREATE TABLE "PlatformConnection" (
    "platform_connection_id" TEXT NOT NULL PRIMARY KEY,
    "client_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'instagram',
    "access_token" TEXT NOT NULL,
    "platform_account_id" TEXT,
    "token_expires_at" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "connected_by_id" TEXT,
    "connected_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformConnection_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client" ("client_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlatformConnection_connected_by_id_fkey" FOREIGN KEY ("connected_by_id") REFERENCES "User" ("user_id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MetricSnapshot" (
    "metric_snapshot_id" TEXT NOT NULL PRIMARY KEY,
    "content_item_id" TEXT NOT NULL,
    "captured_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metric_type" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    CONSTRAINT "MetricSnapshot_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "ContentItem" ("content_item_id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PostRequest" (
    "post_request_id" TEXT NOT NULL PRIMARY KEY,
    "client_id" TEXT NOT NULL,
    "requested_by_id" TEXT,
    "requested_date" DATETIME NOT NULL,
    "related_content_item_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "linked_campaign_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "PostRequest_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client" ("client_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PostRequest_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "User" ("user_id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Comment" (
    "comment_id" TEXT NOT NULL PRIMARY KEY,
    "post_request_id" TEXT,
    "content_item_id" TEXT,
    "author_id" TEXT,
    "body" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Comment_post_request_id_fkey" FOREIGN KEY ("post_request_id") REFERENCES "PostRequest" ("post_request_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Comment_content_item_id_fkey" FOREIGN KEY ("content_item_id") REFERENCES "ContentItem" ("content_item_id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Comment_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "User" ("user_id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PlatformConnection_client_id_status_idx" ON "PlatformConnection"("client_id", "status");

-- CreateIndex
CREATE INDEX "MetricSnapshot_content_item_id_metric_type_captured_at_idx" ON "MetricSnapshot"("content_item_id", "metric_type", "captured_at");

-- CreateIndex
CREATE INDEX "PostRequest_client_id_status_idx" ON "PostRequest"("client_id", "status");

-- CreateIndex
CREATE INDEX "Comment_post_request_id_idx" ON "Comment"("post_request_id");

-- CreateIndex
CREATE INDEX "Comment_content_item_id_idx" ON "Comment"("content_item_id");
