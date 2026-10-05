import { AppError } from '../../lib/errors.js';
import * as follows from '../social/follows/follows.service.js';
import * as reputation from '../social/reputation/reputation.service.js';
import type { BadgeDto } from '../social/reputation/reputation.service.js';
import type { SocialActor } from '../social/shared/actor.js';
import { isoDateTime } from '../social/shared/dates.js';
import { anonymousViewer, type Viewer } from '../social/shared/visibility.js';
import * as repo from './users.repository.js';

/**
 * Profile service.
 *
 * The follow state comes from the follows module's own service rather than a
 * second count query written here. That function exists for exactly this
 * caller — its doc comment says "for a profile header" — and reusing it means
 * the number on a profile and the number the follow button updates cannot
 * disagree.
 */

export interface PublicProfileDto {
  id: string;
  username: string | null;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  faculty: { id: string; name: string; code: string } | null;
  program: { id: string; name: string; code: string } | null;
  enrollmentYear: number | null;
  joinedAt: string;
  /** Every number here is what *this viewer* can see, not the account's totals. */
  stats: { posts: number; documents: number; followers: number; following: number };
  /**
   * All-time, and it can be negative — a penalised account goes below zero
   * rather than being clamped at it.
   *
   * Not viewer-filtered, unlike the counts above. Reputation is not content:
   * what a reader may see of your posts has no bearing on whether you hold a
   * badge, and withholding it would make the number meaningless.
   */
  reputation: number;
  badges: BadgeDto[];
  isFollowedByViewer: boolean;
  isSelf: boolean;
  permissions: { canFollow: boolean };
}

export async function getProfile(
  userId: string,
  actor: SocialActor | null,
): Promise<PublicProfileDto> {
  const viewer: Viewer = actor?.viewer ?? anonymousViewer;

  const row = await repo.findProfileById(userId);
  // 404, not an empty profile. An anonymised account is gone, and a tombstone
  // page would go on confirming that the id was once somebody.
  if (!row) throw new AppError('USER_NOT_FOUND', 'Không tìm thấy người dùng.');

  const isSelf = actor?.userId === userId;

  const [posts, documents, follow, standing] = await Promise.all([
    repo.countVisiblePosts(userId, viewer),
    repo.countVisibleDocuments(userId, viewer),
    follows.getFollowState(userId, actor),
    reputation.summaryFor(userId),
  ]);

  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    bio: row.bio,
    avatarUrl: row.avatarUrl,
    coverUrl: row.coverUrl,
    // A left join can leave the id present with no name only if the referenced
    // row vanished between statements, so requiring both is belt-and-braces
    // rather than a real case.
    faculty:
      row.facultyId && row.facultyName
        ? { id: row.facultyId, name: row.facultyName, code: row.facultyCode ?? '' }
        : null,
    program:
      row.programId && row.programName
        ? { id: row.programId, name: row.programName, code: row.programCode ?? '' }
        : null,
    enrollmentYear: row.enrollmentYear,
    joinedAt: isoDateTime(row.createdAt),
    stats: {
      posts,
      documents,
      followers: follow.followers,
      following: follow.following,
    },
    reputation: standing.reputation,
    badges: standing.badges,
    isFollowedByViewer: follow.isFollowing,
    isSelf,
    // Cosmetic, like every other `permissions` block. The follow endpoint
    // re-checks: it refuses a self-follow outright, and a signed-out viewer has
    // no actor to follow with.
    permissions: { canFollow: !isSelf && actor !== null },
  };
}
