import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/prisma/client";

// Prisma 7 connects through an explicit driver adapter rather than an engine
// binary, so the datasource URL is supplied here rather than in schema.prisma.
const url = process.env.DATABASE_URL ?? "file:./prisma/dev.db";

// Next's dev server hot-reloads modules on every edit. Without this the app
// would open a fresh connection per reload and eventually exhaust SQLite's
// handles, so the instance is cached on globalThis in development only.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createClient() {
  return new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url }),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
