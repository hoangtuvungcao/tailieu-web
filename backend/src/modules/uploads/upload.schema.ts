import { z } from 'zod';

import { uuidSchema } from '../../lib/validation.js';

/**
 * Upload request schemas.
 *
 * Note what is NOT accepted: a storage key, a bucket, or a content hash. The
 * client describes the file it intends to send; the server decides where it
 * goes and verifies what actually arrived. Accepting a client-supplied key
 * would let an upload overwrite an arbitrary object.
 */

export const createUploadSchema = z
  .object({
    /** Original filename. Never used to build a storage key — only stored and echoed back. */
    fileName: z.string().trim().min(1, 'Thiếu tên tệp.').max(255),
    /**
     * Total size in bytes.
     *
     * Trusted only for computing the chunk count and rejecting an obviously
     * oversized upload early. The authoritative check is per-chunk byte
     * counting, because a client can lie here.
     */
    sizeBytes: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    mimeType: z.string().trim().max(160).nullish().transform((v) => v ?? null),
  })
  .strict();

export const chunkParamsSchema = z.object({
  id: uuidSchema,
  index: z.coerce.number().int().min(0).max(100_000),
});

export const sessionParamsSchema = z.object({
  id: uuidSchema,
});

export const listUploadsQuerySchema = z.object({
  status: z.enum(['pending', 'assembling', 'completed', 'aborted', 'expired']).optional(),
});

export type CreateUploadInput = z.infer<typeof createUploadSchema>;
