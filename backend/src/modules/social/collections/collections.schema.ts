import { z } from 'zod';

import { paginationSchema } from '../../../lib/pagination.js';
import { uuidSchema } from '../../../lib/validation.js';

/**
 * Collections request shapes.
 *
 * `visibility` reuses the document levels verbatim. A collection is a
 * container for documents, and a third vocabulary for the same three ideas
 * would force the client to translate between them for no benefit.
 */

const titleSchema = z
  .string()
  .trim()
  .min(1, 'Tên bộ sưu tập không được để trống.')
  .max(120, 'Tên bộ sưu tập quá dài (tối đa 120 ký tự).');

const descriptionSchema = z
  .string()
  .trim()
  .max(2000, 'Mô tả quá dài (tối đa 2000 ký tự).');

const visibilitySchema = z.enum(['public', 'internal', 'private']);

/**
 * What a collection may hold.
 *
 * Narrower than the `social_target` enum on purpose. The database column
 * accepts nine kinds because notifications and subscriptions share the enum,
 * but a collection pointing at a `faculty` or a `tag` is not a thing the API
 * offers — and `collectionItemVisibleTo` has a visibility branch only for
 * these three. Accepting a fourth here would store an item no predicate
 * admits, which reads as "invisible for no reason".
 */
export const collectionItemTargetSchema = z.enum(['document', 'post', 'collection']);

export const createCollectionSchema = z
  .object({
    title: titleSchema,
    description: descriptionSchema.nullish().transform((v) => v ?? null),
    visibility: visibilitySchema.optional().default('private'),
  })
  .strict();

export const updateCollectionSchema = z
  .object({
    title: titleSchema.optional(),
    description: descriptionSchema.nullish().transform((v) => v ?? null),
    visibility: visibilitySchema.optional(),
    coverDocumentId: uuidSchema.nullish().transform((v) => v ?? null),
  })
  .strict();

export const listCollectionsQuerySchema = paginationSchema.extend({
  /** Restrict the discover list to one curator's public collections. */
  ownerUserId: uuidSchema.optional(),
  q: z.string().trim().max(120).optional(),
});

export const collectionIdParamSchema = z.object({ id: uuidSchema });

export const listItemsQuerySchema = paginationSchema;

export const itemParamsSchema = z.object({
  id: uuidSchema,
  itemId: uuidSchema,
});

export const addItemSchema = z
  .object({
    targetType: collectionItemTargetSchema,
    targetId: uuidSchema,
    note: z.string().trim().max(500).nullish().transform((v) => v ?? null),
  })
  .strict();

/**
 * Reorder by listing the item ids in their new order.
 *
 * A client-side drag sends the visible order, so the payload is the whole
 * sequence rather than a pair of positions. The service rewrites `position` for
 * exactly those ids; ids it has never heard of are ignored rather than
 * rejected, because a stale page legitimately holds a superset of what it can
 * see now.
 */
export const reorderItemsSchema = z
  .object({
    itemIds: z.array(uuidSchema).min(1).max(500),
  })
  .strict();
