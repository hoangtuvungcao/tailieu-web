import { db } from '../../../db/client.js';
import { AppError } from '../../../lib/errors.js';
import { decodeCursor } from '../../../lib/cursor.js';
import { paginate, paginationMeta, type PaginationInput } from '../../../lib/pagination.js';
import { isoDateTimeOrNull as iso } from '../shared/dates.js';
import type { SocialActor } from '../shared/actor.js';
import type { Viewer } from '../shared/visibility.js';
import * as repo from './posts.repository.js';
import type { createPostSchema, listPostsQuerySchema, updatePostSchema } from './posts.schema.js';
import type { z } from 'zod';

/**
 * Post service.
 *
 * Authorisation is a single rule, stated once: the author may edit and delete
 * their own post; a moderator within scope may hide it; nobody else may touch
 * it.
 */

export interface PostDto {
  id: string;
  title: string | null;
  body: string;
  postKind: string;
  visibility: string;
  linkUrl: string | null;
  sharedDocumentId: string | null;
  facultyId: string | null;
  author: { id: string; displayName: string; avatarUrl: string | null };
  stats: { likes: number; comments: number; bookmarks: number; hotScore: number };
  tags: { id: string; slug: string; name: string }[];
  /** Whether the *requesting* viewer has liked this post. */
  likedByViewer: boolean;
  createdAt: string;
  editedAt: string | null;
  permissions: { canEdit: boolean; canDelete: boolean; canModerate: boolean };
}

function toDto(
  row: repo.PostRow,
  actor: SocialActor | null,
  tags: { id: string; slug: string; name: string }[],
  likedByViewer: boolean,
): PostDto {
  const isAuthor = actor?.userId === row.authorUserId;
  const isModerator = actor?.permissions.has('posts.moderate') ?? false;
  const isAdmin = actor?.permissions.has('superadmin.all') ?? false;

  return {
    id: row.id,
    title: row.title,
    body: row.body,
    postKind: row.postKind,
    visibility: row.visibility,
    linkUrl: row.linkUrl,
    sharedDocumentId: row.sharedDocumentId,
    facultyId: row.facultyId,
    author: {
      id: row.authorUserId,
      displayName: row.authorName ?? 'Người dùng ẩn danh',
      avatarUrl: row.authorAvatar,
    },
    stats: {
      likes: row.likeCount,
      comments: row.commentCount,
      bookmarks: row.bookmarkCount,
      hotScore: row.hotScore,
    },
    tags,
    likedByViewer,
    createdAt: iso(row.createdAt)!,
    editedAt: iso(row.editedAt),
    permissions: {
      canEdit: isAuthor,
      canDelete: isAuthor || isAdmin,
      canModerate: isModerator || isAdmin,
    },
  };
}

/**
 * Turn a set of post rows into DTOs for one viewer.
 *
 * Exported because the ranked feed renders the same posts and must not grow a
 * second hydration path — tags and liked-state fetched per post is the N+1 this
 * collapses, and a second copy of it would be a second place to reintroduce it.
 */
export async function toDtos(
  rows: repo.PostRow[],
  actor: SocialActor | null,
): Promise<PostDto[]> {
  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);
  const [tagMap, likedIds] = await Promise.all([
    repo.findTagsForPosts(ids),
    repo.findLikedPostIds(ids, actor?.userId ?? null),
  ]);

  return rows.map((row) => toDto(row, actor, tagMap.get(row.id) ?? [], likedIds.has(row.id)));
}

export async function listPosts(
  filters: z.infer<typeof listPostsQuerySchema>,
  actor: SocialActor | null,
) {
  const viewer = actor?.viewer ?? { userId: null, isModerator: false, facultyIds: [] };

  // Whether the caller sent `page` IS the mode: present means numbered pages
  // with a total, absent means the feed's keyset walk.
  const pageMode = filters.page !== undefined;
  const pagination: PaginationInput = { page: filters.page ?? 1, limit: filters.limit };

  // Decoded rather than passed through. A malformed cursor is a bad request,
  // and letting it fall back to page 1 would make a broken link look like a
  // refresh — the reader would scroll from the top again and never know why.
  let cursor: { createdAt: string; id: string } | null = null;
  if (filters.cursor) {
    cursor = decodeCursor(filters.cursor);
    if (!cursor) throw new AppError('BAD_REQUEST', 'Con trỏ không hợp lệ.');
  }

  const page = await repo.listPosts(
    {
      authorUserId: filters.authorUserId,
      facultyId: filters.facultyId,
      followingOnly: filters.following,
      sort: filters.sort,
      cursor,
      wantCursor: !pageMode,
    },
    pagination,
    viewer,
  );

  // Tags and liked-state fetched for the whole page in two queries, not two per
  // post. A 20-post page doing 40 extra round trips is invisible until it is
  // the slowest thing on the site.
  const items = await toDtos(page.items, actor);

  // The two modes report different things, because they can. A cursor page
  // knows there is more without counting anything; an offset page is asked for
  // "how many" and cannot answer without the count.
  if (page.total === null) {
    return { items, meta: { limit: pagination.limit, nextCursor: page.nextCursor } };
  }

  return { items, meta: paginationMeta(paginate([], page.total, pagination)) };
}

export async function getPost(id: string, actor: SocialActor | null): Promise<PostDto> {
  const viewer = actor?.viewer ?? { userId: null, isModerator: false, facultyIds: [] };
  const row = await repo.findPostById(id, viewer);

  // 404 whether the post is missing or merely invisible — a 403 would confirm
  // it exists.
  if (!row) throw new AppError('NOT_FOUND', 'Không tìm thấy bài đăng.');

  const [tags, likedIds] = await Promise.all([
    repo.findPostTags(row.id),
    repo.findLikedPostIds([row.id], actor?.userId ?? null),
  ]);

  return toDto(row, actor, tags, likedIds.has(row.id));
}

export async function createPost(
  input: z.infer<typeof createPostSchema>,
  actor: SocialActor,
): Promise<PostDto> {
  const { id } = await db.transaction(async (tx) => {
    const created = await repo.insertPost(tx, {
      authorUserId: actor.userId,
      title: input.title,
      body: input.body,
      postKind: input.postKind,
      visibility: input.visibility,
      facultyId: input.facultyId,
      linkUrl: input.linkUrl,
      sharedDocumentId: input.sharedDocumentId,
    });

    if (input.tags.length > 0) {
      const tagIds = await repo.upsertTags(tx, input.tags);
      await repo.replacePostTags(tx, created.id, tagIds);
    }

    return created;
  });

  return getPost(id, actor);
}

export async function updatePost(
  id: string,
  input: z.infer<typeof updatePostSchema>,
  actor: SocialActor,
): Promise<PostDto> {
  await db.transaction(async (tx) => {
    const row = await repo.findPostUnscoped(id, tx);
    if (!row) throw new AppError('NOT_FOUND', 'Không tìm thấy bài đăng.');

    // Editing is the author's alone. A moderator can hide content but must not
    // be able to rewrite what somebody said — that would be a very different
    // and much more dangerous power than moderation.
    if (row.authorUserId !== actor.userId) {
      throw new AppError('FORBIDDEN', 'Bạn không có quyền sửa bài đăng này.');
    }

    const { tags, ...fields } = input;
    await repo.updatePost(tx, id, fields);

    if (tags) {
      const tagIds = await repo.upsertTags(tx, tags);
      await repo.replacePostTags(tx, id, tagIds);
    }
  });

  return getPost(id, actor);
}

export async function deletePost(id: string, actor: SocialActor): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await repo.findPostUnscoped(id, tx);
    if (!row) throw new AppError('NOT_FOUND', 'Không tìm thấy bài đăng.');

    const isAuthor = row.authorUserId === actor.userId;
    const canDeleteAny =
      actor.permissions.has('superadmin.all') || actor.permissions.has('posts.moderate');

    if (!isAuthor && !canDeleteAny) {
      throw new AppError('FORBIDDEN', 'Bạn không có quyền xoá bài đăng này.');
    }

    await repo.softDeletePost(tx, id);
  });
}
