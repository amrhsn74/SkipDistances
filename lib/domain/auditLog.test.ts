import { describe, it, expect, beforeEach, afterAll } from "vitest";

import { prisma } from "../db";
import { writeAudit, getAuditTrail, AUDIT_ACTIONS } from "./auditLog";

const ENTITY = "ContentItem" as const;

async function clearTrail(entityId: string) {
  await prisma.auditLog.deleteMany({ where: { entity_id: entityId } });
}

describe("writeAudit", () => {
  const entityId = "test-audit-item-1";

  beforeEach(() => clearTrail(entityId));
  afterAll(async () => {
    await clearTrail(entityId);
    await prisma.$disconnect();
  });

  it("writes a row with the action and entity", async () => {
    await writeAudit({ entityType: ENTITY, entityId, action: "created" });

    const rows = await getAuditTrail(ENTITY, entityId);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("created");
    expect(rows[0].entity_type).toBe(ENTITY);
    expect(rows[0].entity_id).toBe(entityId);
  });

  it("serializes details as JSON", async () => {
    await writeAudit({
      entityType: ENTITY,
      entityId,
      action: "edited",
      details: { from: "drafted", to: "pending_internal_review" },
    });

    const [row] = await getAuditTrail(ENTITY, entityId);
    expect(JSON.parse(row.details!)).toEqual({
      from: "drafted",
      to: "pending_internal_review",
    });
  });

  it("allows a null actor, for system actions like the scheduler publishing", async () => {
    await writeAudit({ entityType: ENTITY, entityId, action: "published" });

    const [row] = await getAuditTrail(ENTITY, entityId);
    expect(row.performed_by_id).toBeNull();
  });

  it("rejects an unknown action rather than recording a typo", async () => {
    await expect(
      // @ts-expect-error -- deliberately outside the union
      writeAudit({ entityType: ENTITY, entityId, action: "approvd" }),
    ).rejects.toThrow(/Unknown audit action/);

    expect(await getAuditTrail(ENTITY, entityId)).toHaveLength(0);
  });

  it("rejects a missing entityId", async () => {
    await expect(
      writeAudit({ entityType: ENTITY, entityId: "", action: "created" }),
    ).rejects.toThrow(/requires an entityId/);
  });

  it("accepts every action in the vocabulary", async () => {
    for (const action of AUDIT_ACTIONS) {
      await writeAudit({ entityType: ENTITY, entityId, action });
    }
    expect(await getAuditTrail(ENTITY, entityId)).toHaveLength(AUDIT_ACTIONS.length);
  });

  it("returns the trail newest first", async () => {
    await writeAudit({ entityType: ENTITY, entityId, action: "created" });
    await writeAudit({ entityType: ENTITY, entityId, action: "edited" });
    await writeAudit({ entityType: ENTITY, entityId, action: "approved" });

    const rows = await getAuditTrail(ENTITY, entityId);
    expect(rows.map((r: { action: string }) => r.action)).toEqual(["approved", "edited", "created"]);
  });

  it("scopes the trail to one entity", async () => {
    const other = "test-audit-item-2";
    await clearTrail(other);
    await writeAudit({ entityType: ENTITY, entityId, action: "created" });
    await writeAudit({ entityType: ENTITY, entityId: other, action: "deleted" });

    expect(await getAuditTrail(ENTITY, entityId)).toHaveLength(1);
    await clearTrail(other);
  });

  it("rolls back with the transaction it is part of, so the trail never records what did not happen", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await writeAudit({ entityType: ENTITY, entityId, action: "scheduled" }, tx);
        throw new Error("simulated failure after the audit write");
      }),
    ).rejects.toThrow("simulated failure");

    expect(await getAuditTrail(ENTITY, entityId)).toHaveLength(0);
  });
});
