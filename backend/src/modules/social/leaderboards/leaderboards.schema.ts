import { z } from 'zod';

import { uuidSchema } from '../../../lib/validation.js';

/**
 * Leaderboard query.
 *
 * `period` is a month key rather than a free-form date or a relative word like
 * `current`, so a response can be cached and a link to "last month's board"
 * stays meaningful tomorrow. It is validated against the same format the writer
 * uses to build the key — a reader that accepts a shape the writer never
 * produces is a reader that returns an empty board for a valid-looking request.
 */
export const leaderboardQuerySchema = z.object({
  period: z
    .string()
    .trim()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Kỳ phải có định dạng YYYY-MM.')
    .optional(),
  scope: z.enum(['university', 'faculty', 'program']).default('university'),
  /** Required for `faculty` and `program`; refused for `university`. */
  scopeId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
