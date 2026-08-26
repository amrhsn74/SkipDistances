import { NextResponse } from "next/server";

import { requireUser } from "@/api/request";
import { errorResponse } from "@/api/respond";
import { prisma } from "@/db";
import { writeAudit } from "@/domain/auditLog";
import { enforce } from "@/domain/permissions";

/**
 * Connecting a client's Instagram account.
 *
 * `P9.1` specified a real OAuth round trip against a Meta developer app. There
 * is no such app here, so the redirect is mocked: this endpoint mints a
 * placeholder token and marks the client connected. Everything downstream is
 * unchanged -- `publishItem` still refuses a client with no connection, and the
 * token is still never returned to a browser.
 *
 * What the mock preserves, because these are the parts that matter:
 *
 *   - **The token never leaves the server.** `GET` reports *that* a client is
 *     connected and never the credential, because `platform.view_credentials` is
 *     a staff capability and a client contact must not see the token even for
 *     their own account.
 *   - **Connecting is audited.** Who connected what, and when.
 *   - **Disconnecting is a status change, not a delete.** A removed row would
 *     erase the fact that the account was ever connected, which the trail needs.
 */

// Reads the session cookie; POST and DELETE write. Never cached.
export const dynamic = "force-dynamic";

/** GET -- whether this client is connected. Never the token itself. */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    await enforce(user, "campaign.view", { clientId: params.id });

    const connection = await prisma.platformConnection.findFirst({
      where: { client_id: params.id },
      orderBy: { connected_at: "desc" },
      select: {
        platform_connection_id: true,
        platform: true,
        platform_account_id: true,
        status: true,
        connected_at: true,
        token_expires_at: true,
      },
    });

    return NextResponse.json({ connection });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST -- connect.
 *
 * Stands in for the OAuth callback. A real implementation exchanges a code for a
 * long-lived token here; this generates one and says so in the audit details, so
 * the trail never claims a real connection was made.
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    await enforce(user, "platform.connect", { clientId: params.id });

    const client = await prisma.client.findUnique({
      where: { client_id: params.id },
      select: { client_id: true },
    });
    if (!client) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: `No client ${params.id}.` } },
        { status: 404 },
      );
    }

    // Any earlier connection is retired rather than removed, so the trail keeps
    // saying the account was connected before.
    await prisma.platformConnection.updateMany({
      where: { client_id: params.id, status: "connected" },
      data: { status: "disconnected" },
    });

    const connection = await prisma.platformConnection.create({
      data: {
        client_id: params.id,
        platform: "instagram",
        // Mocked. A real token would arrive from the OAuth exchange and be
        // encrypted at rest before it ever reached this row.
        access_token: `mock_token_${params.id}_${Date.now()}`,
        platform_account_id: `mock_ig_${params.id}`,
        status: "connected",
        connected_by_id: user.user_id,
        token_expires_at: new Date(Date.now() + 60 * 86_400_000),
      },
      select: {
        platform_connection_id: true,
        platform_account_id: true,
        status: true,
        connected_at: true,
      },
    });

    await writeAudit(
      {
        entityType: "PlatformConnection",
        entityId: connection.platform_connection_id,
        action: "created",
        performedById: user.user_id,
        // Recorded as mocked, so nobody reading the trail later believes a real
        // Instagram account was ever attached.
        details: { client_id: params.id, platform: "instagram", mocked: true },
      },
      undefined,
    );

    return NextResponse.json(connection, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

/** DELETE -- disconnect. A status change, never a row removal. */
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  try {
    const user = await requireUser();
    await enforce(user, "platform.connect", { clientId: params.id });

    const updated = await prisma.platformConnection.updateMany({
      where: { client_id: params.id, status: "connected" },
      data: { status: "disconnected" },
    });

    await writeAudit(
      {
        entityType: "PlatformConnection",
        entityId: params.id,
        action: "edited",
        performedById: user.user_id,
        details: { client_id: params.id, disconnected: updated.count },
      },
      undefined,
    );

    return NextResponse.json({ disconnected: updated.count });
  } catch (error) {
    return errorResponse(error);
  }
}
