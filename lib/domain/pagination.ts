/**
 * One pagination contract, shared by every list.
 *
 * Pure — no database, no Next — so a route, a domain query and a test all agree
 * on what "page 2" means without any of them re-deriving it. Two lists that
 * computed their own offsets would eventually differ by one, and off-by-one in a
 * paginated roster is the kind of bug that hides a client rather than crashing.
 */

/** Bounded so a caller cannot ask for the whole table in one request. */
export const MIN_PAGE_SIZE = 5;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

export type PageRequest = {
  /** 1-based, as it appears in the URL and to the reader. */
  page: number;
  pageSize: number;
};

export type Page<T> = {
  rows: T[];
  page: number;
  pageSize: number;
  /** Total matching rows *before* the page was taken. */
  total: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
};

/**
 * A sane page request from whatever the query string held.
 *
 * Clamped rather than rejected. `?page=0`, `?page=-4` and `?page=banana` are all
 * a reader who typed something odd into a URL, and answering them with page 1 is
 * more useful than a 400 — while `pageSize=100000` is refused by the clamp
 * because it is the one that actually costs something.
 */
export function parsePage(
  rawPage: string | null | undefined,
  rawSize: string | null | undefined,
  defaultSize: number = DEFAULT_PAGE_SIZE,
): PageRequest {
  const page = Math.max(1, toInt(rawPage, 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, toInt(rawSize, defaultSize)));
  return { page, pageSize };
}

/** The `skip`/`take` for a Prisma query. */
export function toSkipTake(request: PageRequest): { skip: number; take: number } {
  return { skip: (request.page - 1) * request.pageSize, take: request.pageSize };
}

/**
 * Wrap rows and a total into a page.
 *
 * `totalPages` is at least 1 even for an empty result, so a screen can say
 * "page 1 of 1" rather than "page 1 of 0", which reads as a bug to anyone
 * looking at it.
 */
export function toPage<T>(rows: T[], total: number, request: PageRequest): Page<T> {
  const totalPages = Math.max(1, Math.ceil(total / request.pageSize));
  return {
    rows,
    page: request.page,
    pageSize: request.pageSize,
    total,
    totalPages,
    hasPrevious: request.page > 1,
    hasNext: request.page < totalPages,
  };
}

function toInt(raw: string | null | undefined, fallback: number): number {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
