import { z } from 'zod';

import { paginationSchema } from '../../lib/pagination.js';
import { uuidSchema } from '../../lib/validation.js';

/**
 * Search request schema.
 *
 * `publishedAfter` / `publishedBefore` are validated as dates here rather than
 * passed through as arbitrary strings, because they reach a SQL comparison. An
 * unvalidated string in a date position either errors confusingly or, worse,
 * silently coerces to something the caller did not intend.
 *
 * `minRating` is bounded to the actual 1–5 scale: there is no point accepting
 * `minRating=99` and returning an empty page, and a bound makes the intent of
 * the parameter explicit.
 */
export const searchQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),

  facultyId: uuidSchema.optional(),
  programId: uuidSchema.optional(),
  subjectId: uuidSchema.optional(),
  courseId: uuidSchema.optional(),
  academicYearId: uuidSchema.optional(),
  semesterId: uuidSchema.optional(),
  documentTypeId: uuidSchema.optional(),
  ownerUserId: uuidSchema.optional(),

  fileKind: z
    .enum(['pdf', 'document', 'spreadsheet', 'presentation', 'archive', 'image', 'text', 'code', 'other'])
    .optional(),

  tag: z.string().trim().max(60).optional(),

  publishedAfter: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày phải theo định dạng YYYY-MM-DD.')
    .optional(),
  publishedBefore: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày phải theo định dạng YYYY-MM-DD.')
    .optional(),

  minRating: z.coerce.number().int().min(1).max(5).optional(),

  sort: z
    .enum(['relevance', 'newest', 'oldest', 'popular', 'rated', 'title'])
    .optional()
    .default('relevance'),
});

export const suggestQuerySchema = z.object({
  q: z.string().trim().min(1, 'Cần nhập từ khoá.').max(120),
  // Capped well below the page-size cap: a typeahead dropdown showing 100
  // entries is unusable, and the query cost is per-suggestion.
  limit: z.coerce.number().int().min(1).max(20).optional().default(8),
});

export const reindexSchema = z
  .object({
    documentIds: z.array(uuidSchema).max(500).optional().default([]),
  })
  .strict();

export type SearchQuery = z.infer<typeof searchQuerySchema>;
