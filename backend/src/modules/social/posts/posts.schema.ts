import { z } from 'zod';

import { cursorSchema } from '../../../lib/cursor.js';
import { paginationSchema } from '../../../lib/pagination.js';
import { uuidSchema } from '../../../lib/validation.js';

/**
 * Post request schemas.
 *
 * `visibility` defaults to `internal`, matching documents — a post is visible
 * to signed-in members until its author says otherwise. `collection` defaults
 * to `private` instead, because a reading list is personal by nature.
 */

export const createPostSchema = z
  .object({
    body: z.string().trim().min(1, 'Nội dung không được để trống.').max(10_000),
    title: z.string().trim().max(200).nullish().transform((v) => v ?? null),
    postKind: z.enum(['status', 'link', 'doc_share']).optional().default('status'),
    visibility: z.enum(['public', 'internal', 'private']).optional().default('internal'),
    facultyId: z.union([uuidSchema, z.null()]).optional().default(null),
    linkUrl: z.string().url('Liên kết không hợp lệ.').max(2000).nullish().transform((v) => v ?? null),
    sharedDocumentId: z.union([uuidSchema, z.null()]).optional().default(null),
    tags: z.array(z.string().trim().min(1).max(60)).max(10).optional().default([]),
  })
  .strict()
  // A link post with no link, or a document share with no document, is a post
  // that renders as an empty box. Caught here rather than in the UI.
  .refine((v) => v.postKind !== 'link' || v.linkUrl !== null, {
    path: ['linkUrl'],
    message: 'Bài đăng dạng liên kết phải có liên kết.',
  })
  .refine((v) => v.postKind !== 'doc_share' || v.sharedDocumentId !== null, {
    path: ['sharedDocumentId'],
    message: 'Bài đăng chia sẻ tài liệu phải chọn một tài liệu.',
  });

export const updatePostSchema = z
  .object({
    body: z.string().trim().min(1).max(10_000).optional(),
    title: z.string().trim().max(200).nullish().transform((v) => v ?? null),
    visibility: z.enum(['public', 'internal', 'private']).optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
  })
  .strict();

export const listPostsQuerySchema = paginationSchema.extend({
  /**
   * No default, unlike `paginationSchema`. Whether this is present IS the mode
   * selector:
   *
   *   `page` sent      → numbered pages, and `meta.total`
   *   `page` omitted   → keyset, and `meta.nextCursor`
   *
   * A default here would make the two indistinguishable, and the first page of
   * a cursor walk — which has no cursor yet — would come back in offset shape
   * with no way to continue. "Asking for a page number gets you page numbers"
   * is also the rule a caller would guess.
   */
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  authorUserId: uuidSchema.optional(),
  facultyId: uuidSchema.optional(),
  following: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  sort: z.enum(['newest', 'popular']).optional().default('newest'),
  /** Keyset position from a previous response's `meta.nextCursor`. */
  cursor: cursorSchema.optional(),
});

export const postIdParamSchema = z.object({ id: uuidSchema });
