import { z } from 'zod';

import { uuidSchema } from '../../lib/validation.js';

/**
 * Report schemas.
 *
 * `reportTargetSchema` is deliberately NARROWER than the `report_target`
 * database enum. That enum also carries `group`, `question` and `answer`,
 * reserving space for features that do not exist yet. Accepting a report
 * against one of those today would file an allegation nobody could ever
 * resolve: there is no row to look up, no title to show a moderator, and no
 * screen it could appear on. The queue would fill with reports that can only
 * ever be rejected, and the first unreviewable entry is the moment moderators
 * stop trusting the queue.
 *
 * So the API accepts what it can actually verify, and the enum grows to meet
 * each feature as that feature lands.
 */
export const reportTargetSchema = z.enum([
  'document',
  'post',
  'comment',
  'user',
  'collection',
]);

export const reportReasonSchema = z.enum([
  'spam',
  'copyright',
  'malware',
  'wrong_content',
  'sensitive',
  'harassment',
  'fake_document',
  'misleading',
  'other',
]);

export const createReportBody = z
  .object({
    targetType: reportTargetSchema,
    targetId: uuidSchema,
    reason: reportReasonSchema,
    /**
     * Optional, because the reason alone often suffices — "mã độc" on a PDF
     * needs no elaboration. Bounded and trimmed so a report cannot be used as
     * free storage, and an all-whitespace detail is stored as absent rather
     * than as an empty string the moderator has to squint at.
     */
    details: z
      .string()
      .trim()
      .max(2000, 'Nội dung mô tả tối đa 2000 ký tự.')
      .optional()
      .transform((value) => (value ? value : undefined)),
  })
  .strict();

export type CreateReportBody = z.infer<typeof createReportBody>;
