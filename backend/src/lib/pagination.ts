import { z } from 'zod';

/**
 * Pagination.
 *
 * OFFSET BY DEFAULT, chosen deliberately: most lists here are browse-and-filter
 * interfaces that want page numbers and a total ("1,247 documents across 63
 * pages"), and cursors cannot answer "how many are there?" without a second
 * query.
 *
 * The exceptions are the social feeds, which page by keyset cursor instead —
 * see `lib/cursor.ts` and `posts.repository.ts`. A feed is read while it is
 * being written to, so a post published mid-read shifts every later row down
 * and OFFSET hands the reader a repeat and hides the row that was pushed over
 * the boundary. Those endpoints select the mode by whether `page` is sent; this
 * module defines only the offset half.
 *
 * The limit is capped so that a crafted `?limit=1000000` cannot be used to
 * exhaust memory or dump the table.
 */

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional().default(DEFAULT_PAGE_SIZE),
});

export type PaginationInput = z.infer<typeof paginationSchema>;

export interface Paginated<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function toOffset(input: PaginationInput): number {
  return (input.page - 1) * input.limit;
}

export function paginate<T>(items: T[], total: number, input: PaginationInput): Paginated<T> {
  return {
    items,
    page: input.page,
    limit: input.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / input.limit)),
  };
}

/** Shape returned in the envelope's `meta` field alongside paginated data. */
export function paginationMeta(paginated: Paginated<unknown>): Record<string, unknown> {
  return {
    page: paginated.page,
    limit: paginated.limit,
    total: paginated.total,
    totalPages: paginated.totalPages,
    hasNext: paginated.page < paginated.totalPages,
    hasPrev: paginated.page > 1,
  };
}

/**
 * Build a stable, human-readable URL slug from Vietnamese text.
 *
 * Diacritics are folded rather than stripped: "Lập trình C++" becomes
 * "lap-trinh-c", and "Điện tử" becomes "dien-tu" (the đ/Đ mapping is separate
 * because NFD decomposition does not touch it — it is a distinct letter, not a
 * decorated d).
 */
export function slugify(input: string, maxLength = 80): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

/** Append a short suffix so a slug collision does not fail the whole insert. */
export function uniqueSlug(base: string, suffix: string): string {
  const trimmed = base.slice(0, 60).replace(/-+$/g, '');
  return `${trimmed}-${suffix}`.slice(0, 80);
}
