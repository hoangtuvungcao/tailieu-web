import { db } from '../../../db/client.js';
import { AppError } from '../../../lib/errors.js';
import { paginate, type PaginationInput } from '../../../lib/pagination.js';
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

export interface SocialActor {
  userId: string;
  viewer: Viewer;
  permissions: Set<string>;
}

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

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
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

export async function listPosts(
  filters: z.infer<typeof listPostsQuerySchema>,
  pagination: PaginationInput,
  actor: SocialActor | null,
) {
  const viewer = actor?.viewer ?? { userId: null, isModerator: false, facultyIds: [] };

  const { items, total } = await repo.listPosts(
    {
      authorUserId: filters.authorUserId,
      facultyId: filters.facultyId,
      followingOnly: filters.following,
      sort: filters.sort,
    },
    pagination,
    viewer,
  );

  // Tags and liked-state fetched for the whole page in two queries, not two per
  // post. A 20-post page doing 40 extra round trips is invisible until it is
  // the slowest thing on the site.
  const ids = items.map((p) => p.id);
  const [tagMap, likedIds] = await Promise.all([
    repo.findTagsForPosts(ids),
    repo.findLikedPostIds(ids, actor?.userId ?? null),
  ]);

  return paginate(
    items.map((row) => toDto(row, actor, tagMap.get(row.id) ?? [], likedIds.has(row.id))),
    total,
    pagination,
  );
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
