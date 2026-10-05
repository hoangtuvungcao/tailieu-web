import { z } from 'zod';

/**
 * Feed query.
 *
 * `limit` is capped at 50 rather than left open. The trending read hydrates ids
 * through Postgres, and a crafted `?limit=10000` would turn one request into a
 * ten-thousand-row `IN` — cheap to send, expensive to serve.
 */
export const feedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});
