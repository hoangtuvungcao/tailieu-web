import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Social enums.
 *
 * Visibility reuses the `document_visibility` enum rather than defining a
 * parallel one — the same three levels mean the same thing, and two enums with
 * identical values drift the moment somebody adds a fourth to one of them.
 */

export const postKindEnum = pgEnum('post_kind', [
  'status',
  'link',
  'doc_share',
]);

export const moderationStateEnum = pgEnum('moderation_state', [
  'visible',
  'hidden',
  'removed',
]);

export const commentTargetEnum = pgEnum('comment_target', [
  'document',
  'post',
]);

export const reactionEnum = pgEnum('reaction', [
  'like',
  'insightful',
]);

/**
 * What a subscription, bookmark, collection item, notification or reputation
 * entry can point at.
 *
 * One shared enum rather than one per table because these are all
 * "pointers to something", and a value added for one is meaningful for the
 * others.
 */
export const socialTargetEnum = pgEnum('social_target', [
  'document',
  'post',
  'comment',
  'user',
  'collection',
  'faculty',
  'program',
  'subject',
  'tag',
]);

export const notificationKindEnum = pgEnum('notification_kind', [
  'post_like',
  'comment_like',
  'post_comment',
  'comment_reply',
  'follow',
  'document_like',
  'rating_received',
  'badge_awarded',
  'collection_share',
  'moderation',
  'system',
  // Appended rather than slotted next to `post_comment`, where it reads better.
  // `ALTER TYPE ... ADD VALUE` can only append, so a value declared mid-list
  // would leave the TypeScript order and the database order disagreeing — and
  // an enum whose two definitions differ is the kind of drift that only shows
  // up much later.
  'document_comment',
]);

export const reputationReasonEnum = pgEnum('reputation_reason', [
  'document_published',
  'like_received',
  'comment_like_received',
  'rating_received',
  'moderation_penalty',
  'spam_penalty',
  'manual_adjust',
]);

export const leaderboardPeriodEnum = pgEnum('leaderboard_period', [
  'monthly',
  'semester',
  'yearly',
  'all_time',
]);

export const leaderboardScopeEnum = pgEnum('leaderboard_scope', [
  'university',
  'faculty',
  'program',
]);
