import { describe, it, expect } from "vitest";

import { prisma } from "../db";
import { listClients, listClientsPaged } from "./clientRoster";

/**
 * Filtering and paging the roster.
 *
 * Asserted against the seeded 150-client roster rather than fixtures: the whole
 * point of paging is behaviour at real volume, and CL-101/CL-109 are known
 * fixed points that cannot drift.
 */

/** An account manager who holds a decent slice of the roster. */
async function aManager() {
  const client = await prisma.client.findFirstOrThrow({
    where: { NOT: { account_manager_id: null } },
    select: { account_manager_id: true },
  });
  return prisma.user.findUniqueOrThrow({
    where: { user_id: client.account_manager_id! },
    select: { user_id: true, user_type: true, is_agency_admin: true },
  });
}

async function anAdmin() {
  return prisma.user.findFirstOrThrow({
    where: { is_agency_admin: true },
    select: { user_id: true, user_type: true, is_agency_admin: true },
  });
}

describe("listClientsPaged", () => {
  it("returns a page and the total behind it", async () => {
    const admin = await anAdmin();
    const total = await prisma.client.count();

    const page = await listClientsPaged(admin, {}, { page: 1, pageSize: 10 });

    expect(page.rows).toHaveLength(10);
    expect(page.total).toBe(total);
    expect(page.totalPages).toBe(Math.ceil(total / 10));
    expect(page.hasNext).toBe(true);
    expect(page.hasPrevious).toBe(false);
  });

  it("advances without repeating a row", async () => {
    const admin = await anAdmin();

    const first = await listClientsPaged(admin, {}, { page: 1, pageSize: 10 });
    const second = await listClientsPaged(admin, {}, { page: 2, pageSize: 10 });

    const overlap = first.rows
      .map((r) => r.client_id)
      .filter((id) => second.rows.some((r) => r.client_id === id));

    expect(overlap).toEqual([]);
  });

  /**
   * The property paging must not break. A manager sees their own clients and no
   * others whether the list is paged or not -- so the paged total must equal the
   * unpaged length, never the whole roster.
   */
  it("pages within the caller's scope, never past it", async () => {
    const manager = await aManager();

    const everything = await listClients(manager);
    const page = await listClientsPaged(manager, {}, { page: 1, pageSize: 5 });

    expect(page.total).toBe(everything.length);
    expect(page.total).toBeLessThan(await prisma.client.count());
  });

  it("filters by status", async () => {
    const admin = await anAdmin();

    const page = await listClientsPaged(admin, { status: "inactive" }, { page: 1, pageSize: 100 });

    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((r) => r.status === "inactive")).toBe(true);
  });

  it("filters by sensitive sector", async () => {
    const admin = await anAdmin();

    const page = await listClientsPaged(
      admin,
      { sensitiveSector: true },
      { page: 1, pageSize: 100 },
    );

    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((r) => r.sensitive_sector)).toBe(true);
  });

  it("searches name and client id", async () => {
    const admin = await anAdmin();

    const byId = await listClientsPaged(admin, { search: "CL-101" }, { page: 1, pageSize: 20 });
    expect(byId.rows.map((r) => r.client_id)).toContain("CL-101");

    const byName = await listClientsPaged(admin, { search: "NileFit" }, { page: 1, pageSize: 20 });
    expect(byName.rows.map((r) => r.name)).toContain("NileFit");
  });

  it("filters by market", async () => {
    const admin = await anAdmin();
    const market = await prisma.market.findFirstOrThrow({ where: { country_code: "SA" } });

    const page = await listClientsPaged(
      admin,
      { marketId: market.market_id },
      { page: 1, pageSize: 100 },
    );

    expect(page.rows.length).toBeGreaterThan(0);
    expect(
      page.rows.every((r) => r.markets.some((m) => m.market_id === market.market_id)),
    ).toBe(true);
  });

  /**
   * The leak this module's scoping exists to prevent. A filter is ANDed onto the
   * scope, so naming a client outside it narrows to nothing rather than
   * reaching it.
   */
  it("cannot be widened by searching for a client outside scope", async () => {
    const manager = await aManager();

    const mine = await listClients(manager);
    const outside = await prisma.client.findFirstOrThrow({
      where: { client_id: { notIn: mine.map((c) => c.client_id) } },
      select: { client_id: true },
    });

    const page = await listClientsPaged(
      manager,
      { search: outside.client_id },
      { page: 1, pageSize: 20 },
    );

    expect(page.rows).toHaveLength(0);
    expect(page.total).toBe(0);
  });

  it("returns an empty page rather than throwing past the last page", async () => {
    const admin = await anAdmin();

    const page = await listClientsPaged(admin, {}, { page: 9999, pageSize: 20 });

    expect(page.rows).toEqual([]);
    // The total still reports what matched, so a screen can say "no rows on
    // this page" rather than "no clients".
    expect(page.total).toBeGreaterThan(0);
  });
});
