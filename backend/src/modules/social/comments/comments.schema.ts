import { z } from 'zod';

import { paginationSchema } from '../../../lib/pagination.js';
import { uuidSchema } from '../../../lib/validation.js';

/**
 * Comment request schemas.
 *
 * `parentCommentId` is what makes a comment a reply; depth and the thread root
 * are derived on the server and deliberately not accepted from the client —
 * they are structural, and letting a client set them would let it forge a reply
 * chain that skips the depth cap.
 */

export const createCommentSchema = z
  .object({
    targetType: z.enum(['document', 'post']),
    targetId: uuidSchema,
    body: z.string().trim().min(1, 'Nội dung không được để trống.').max(5000),
    parentCommentId: z.union([uuidSchema, z.null()]).optional().default(null),
  })
  .strict();

export const updateCommentSchema = z
  .object({
    body: z.string().trim().min(1).max(5000),
  })
  .strict();

export const listCommentsQuerySchema = paginationSchema.extend({
  targetType: z.enum(['document', 'post']),
  targetId: uuidSchema,
});

export const commentIdParamSchema = z.object({ id: uuidSchema });
