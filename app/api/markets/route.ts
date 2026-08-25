import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { prisma } from "@/db";

/**
 * The seeded markets, for the multi-select on the client form.
 *
 * A table rather than an enum, so a third market is a data insert and no code
 * changes. That is exactly why the form reads them from here instead of
 * hardcoding Egypt and Saudi Arabia -- a hardcoded list would silently refuse a
 * market the database already has.
 *
 * Signed-in only, but not otherwise scoped: which markets exist is not a fact
 * about any client, so there is nothing here to leak between them.
 */
export const dynamic = "force-dynamic";

/** GET /api/markets */
export async function GET() {
  try {
    await requireUser();

    const markets = await prisma.market.findMany({
      select: { market_id: true, name: true, country_code: true },
      orderBy: { name: "asc" },
    });

    return NextResponse.json({ markets });
  } catch (error) {
    return errorResponse(error);
  }
}
