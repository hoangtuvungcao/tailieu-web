import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Postgres enums.
 *
 * Only genuinely closed sets live here. Anything an administrator may need to
 * extend (document categories, faculties, programs) is a TABLE instead — an
 * enum requires a migration to change, which would violate the requirement
 * that taxonomy stays editable at runtime.
 *
 * Note on `ALTER TYPE ... ADD VALUE`: new enum values cannot be used in the
 * same transaction that adds them, so extending these is a two-step
 * deployment. Keep the sets small and stable.
 */

export const userStatusEnum = pgEnum('user_status', [
  'active',
  'suspended',
  'deactivated',
]);

export const authProviderEnum = pgEnum('auth_provider', [
  'password',
  'google',
]);

export const authTokenTypeEnum = pgEnum('auth_token_type', [
  'email_verification',
  'password_reset',
]);

export const verificationStatusEnum = pgEnum('verification_status', [
  'pending',
  'approved',
  'rejected',
]);

export const degreeLevelEnum = pgEnum('degree_level', [
  'undergraduate',
  'postgraduate',
  'college',
]);

export const documentVisibilityEnum = pgEnum('document_visibility', [
  'public',
  'internal',
  'private',
]);

export const documentStatusEnum = pgEnum('document_status', [
  'draft',
  'pending_review',
  'published',
  'rejected',
  'archived',
]);

/**
 * Coarse file kind, derived from the DETECTED mime type — never from the
 * user-supplied filename or extension. Drives which previewer is used.
 */
export const fileKindEnum = pgEnum('file_kind', [
  'pdf',
  'document',
  'spreadsheet',
  'presentation',
  'archive',
  'image',
  'text',
  'code',
  'other',
]);

export const fileStatusEnum = pgEnum('file_status', [
  'pending',
  'ready',
  'failed',
]);

export const previewStatusEnum = pgEnum('preview_status', [
  'none',
  'queued',
  'processing',
  'ready',
  'failed',
  'unsupported',
]);

export const uploadSessionStatusEnum = pgEnum('upload_session_status', [
  'pending',
  'assembling',
  'completed',
  'aborted',
  'expired',
]);

export const reportReasonEnum = pgEnum('report_reason', [
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

export const copyrightStatusEnum = pgEnum('copyright_status', [
  'unknown',
  'cleared',
  'permission_granted',
  'public_domain',
  'fair_use',
  'infringing',
]);

export const moderationPolicyEnum = pgEnum('moderation_policy', [
  'allowed',
  'review_required',
  'blocked',
]);

/** What a report can point at. Polymorphic — see reports.ts for why. */
export const reportTargetEnum = pgEnum('report_target', [
  'document',
  'post',
  'comment',
  'user',
  'collection',
  'group',
  'question',
  'answer',
]);

export const reportStatusEnum = pgEnum('report_status', [
  'pending',
  'reviewing',
  'resolved',
  'rejected',
]);
