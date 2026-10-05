import { z } from 'zod';

import { paginationSchema } from '../../lib/pagination.js';
import { uuidSchema } from '../../lib/validation.js';

/**
 * Document request schemas.
 *
 * Note what a client cannot set: `status`, `downloadCount`, `ratingCount`,
 * `ownerUserId`, or any storage field. Status is derived from the category's
 * moderation policy and changed only through the moderation endpoint;
 * counters are maintained server-side from real events. Accepting any of them
 * from the client is how a document self-publishes or a download count becomes
 * meaningless.
 */

export const createDocumentSchema = z
  .object({
    title: z.string().trim().min(3, 'Tiêu đề phải có ít nhất 3 ký tự.').max(300),
    description: z.string().trim().max(5000).nullish().transform((v) => v ?? null),

    documentTypeId: uuidSchema,
    /** Required: every document belongs to a faculty. Enforced by the schema. */
    facultyId: uuidSchema,
    programId: z.union([uuidSchema, z.null()]).optional().default(null),
    subjectId: z.union([uuidSchema, z.null()]).optional().default(null),
    courseId: z.union([uuidSchema, z.null()]).optional().default(null),
    academicYearId: z.union([uuidSchema, z.null()]).optional().default(null),
    semesterId: z.union([uuidSchema, z.null()]).optional().default(null),

    visibility: z.enum(['public', 'internal', 'private']).optional().default('internal'),
    language: z.string().trim().max(10).optional().default('vi'),

    /** Ids of COMPLETED upload sessions. At least one is required. */
    uploadIds: z
      .array(uuidSchema)
      .min(1, 'Cần ít nhất một tệp đã tải lên hoàn tất.')
      .max(10, 'Mỗi tài liệu chỉ được có tối đa 10 tệp.'),

    tags: z.array(z.string().trim().min(1).max(60)).max(20).optional().default([]),

    // --- Copyright / content policy (§28) ---------------------------------
    license: z.string().trim().max(120).nullish().transform((v) => v ?? null),
    source: z.string().trim().max(500).nullish().transform((v) => v ?? null),
    attribution: z.string().trim().max(500).nullish().transform((v) => v ?? null),
    copyrightStatus: z
      .enum(['unknown', 'cleared', 'permission_granted', 'public_domain', 'fair_use', 'infringing'])
      .optional()
      .default('unknown'),
    /**
     * The uploader asserts they have the right to share this.
     *
     * Must be literally true. The DB column defaults to false, so omitting it
     * cannot accidentally count as consent.
     */
    uploaderConfirmed: z.literal(true, {
      errorMap: () => ({
        message: 'Bạn cần xác nhận có quyền chia sẻ tài liệu này.',
      }),
    }),
  })
  .strict();

export const updateDocumentSchema = z
  .object({
    title: z.string().trim().min(3).max(300).optional(),
    description: z.string().trim().max(5000).nullish().transform((v) => v ?? null),
    documentTypeId: uuidSchema.optional(),
    programId: z.union([uuidSchema, z.null()]).optional(),
    subjectId: z.union([uuidSchema, z.null()]).optional(),
    courseId: z.union([uuidSchema, z.null()]).optional(),
    academicYearId: z.union([uuidSchema, z.null()]).optional(),
    semesterId: z.union([uuidSchema, z.null()]).optional(),
    visibility: z.enum(['public', 'internal', 'private']).optional(),
    language: z.string().trim().max(10).optional(),
    tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    license: z.string().trim().max(120).nullish().transform((v) => v ?? null),
    source: z.string().trim().max(500).nullish().transform((v) => v ?? null),
    attribution: z.string().trim().max(500).nullish().transform((v) => v ?? null),
    copyrightStatus: z
      .enum(['unknown', 'cleared', 'permission_granted', 'public_domain', 'fair_use', 'infringing'])
      .optional(),
  })
  .strict()
  // `facultyId` is intentionally absent. Moving a document between faculties
  // rewrites the meaning of its academic record; that is a moderation action
  // with an audit entry, not a metadata edit by the owner.

export const listDocumentsQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(200).optional(),
  facultyId: uuidSchema.optional(),
  programId: uuidSchema.optional(),
  subjectId: uuidSchema.optional(),
  courseId: uuidSchema.optional(),
  academicYearId: uuidSchema.optional(),
  semesterId: uuidSchema.optional(),
  documentTypeId: uuidSchema.optional(),
  fileKind: z
    .enum(['pdf', 'document', 'spreadsheet', 'presentation', 'archive', 'image', 'text', 'code', 'other'])
    .optional(),
  visibility: z.enum(['public', 'internal', 'private']).optional(),
  status: z
    .enum(['draft', 'pending_review', 'published', 'rejected', 'archived'])
    .optional(),
  tag: z.string().trim().max(60).optional(),
  ownerUserId: uuidSchema.optional(),
  /** Only meaningful for the owner's own view. */
  mine: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  sort: z
    .enum(['relevance', 'newest', 'oldest', 'popular', 'rated', 'title'])
    .optional()
    .default('newest'),
});

export const ratingSchema = z
  .object({
    rating: z.coerce.number().int().min(1, 'Đánh giá từ 1 đến 5 sao.').max(5, 'Đánh giá từ 1 đến 5 sao.'),
    review: z.string().trim().max(2000).nullish().transform((v) => v ?? null),
  })
  .strict();

export const moderateDocumentSchema = z
  .object({
    action: z.enum(['publish', 'reject', 'archive', 'restore']),
    reason: z.string().trim().max(1000).nullish().transform((v) => v ?? null),
  })
  .strict();

export const documentIdParamSchema = z.object({ id: uuidSchema });
export const documentFileParamSchema = z.object({ id: uuidSchema, fileId: uuidSchema });

export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;
