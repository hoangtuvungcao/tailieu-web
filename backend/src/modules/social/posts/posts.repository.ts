import { and, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import { db, type Database } from '../../../db/client.js';
import { follows, postLikes, postTags, posts, tags, users } from '../../../db/schema/index.js';
import { toOffset, type PaginationInput } from '../../../lib/pagination.js';
import { postVisibilityPredicate, type Viewer } from '../shared/visibility.js';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Tx | typeof db;

/**
 * Post data access.
 *
 * Every function that can return a post takes a `viewer` and applies
 * `postVisibilityPredicate` **in SQL**. There is no variant that returns rows
 * first and filters later — that shape is how a hidden or private post reaches
 * someone it should not, because the filter is one forgotten line away.
 */

const postColumns = {
  id: posts.id,
  authorUserId: posts.authorUserId,
  authorName: users.displayName,
  authorAvatar: users.avatarUrl,
  title: posts.title,
  body: posts.body,
  postKind: posts.postKind,
  visibility: posts.visibility,
  facultyId: posts.facultyId,
  linkUrl: posts.linkUrl,
  sharedDocumentId: posts.sharedDocumentId,
  likeCount: posts.likeCount,
  commentCount: posts.commentCount,
  bookmarkCount: posts.bookmarkCount,
  hotScore: posts.hotScore,
  moderationState: posts.moderationState,
  pinnedAt: posts.pinnedAt,
  editedAt: posts.editedAt,
  createdAt: posts.createdAt,
  updatedAt: posts.updatedAt,
};

export interface PostRow {
  id: string;
  authorUserId: string;
  authorName: string | null;
  authorAvatar: string | null;
  title: string | null;
  body: string;
  postKind: 'status' | 'link' | 'doc_share';
  visibility: 'public' | 'internal' | 'private';
  facultyId: string | null;
  linkUrl: string | null;
  sharedDocumentId: string | null;
  likeCount: number;
  commentCount: number;
  bookmarkCount: number;
  hotScore: number;
  moderationState: 'visible' | 'hidden' | 'removed';
  pinnedAt: Date | string | null;
  editedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

function baseQuery(executor: Executor) {
  return executor
    .select(postColumns)
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorUserId));
}

function normalise(row: Record<string, unknown>): PostRow {
  return {
    ...row,
    likeCount: Number(row.likeCount ?? 0),
    commentCount: Number(row.commentCount ?? 0),
    bookmarkCount: Number(row.bookmarkCount ?? 0),
    hotScore: Number(row.hotScore ?? 0),
  } as PostRow;
}

export interface PostListOptions {
  authorUserId?: string;
  facultyId?: string;
  viewerUserId?: string;
  /** Only posts by accounts this viewer follows. */
  followingOnly?: boolean;
  sort?: 'newest' | 'popular';
}

/**
 * Paginated post list.
 *
 * `cursor` is `(created_at, id)` from the last row of the previous page —
 * keyset pagination, not OFFSET. With OFFSET, a post published while the reader
 * is on page 2 shifts everything down and page 3 repeats a row they already
 * saw. The `id` tiebreaker matters because two posts can share a millisecond.
 */
export async function listPosts(
  options: PostListOptions,
  pagination: PaginationInput,
  viewer: Viewer,
  executor: Executor = db,
) {
  const predicates: SQL[] = [postVisibilityPredicate(viewer)];

  if (options.authorUserId) predicates.push(eq(posts.authorUserId, options.authorUserId));
  if (options.facultyId) predicates.push(eq(posts.facultyId, options.facultyId));

  if (options.followingOnly && viewer.userId) {
    predicates.push(
      sql`EXISTS (
        SELECT 1 FROM follows
         WHERE follows.follower_user_id = ${viewer.userId}
           AND follows.followee_user_id = ${posts.authorUserId}
           AND follows.deleted_at IS NULL
      )`,
    );
  }

  const where = and(...predicates)!;

  // Popular sorts on the stored engagement score, which carries no time term —
  // that is what makes it indexable. Recency is applied as a tiebreak rather
  // than folded into the score, because a stored score containing `now()` would
  // change without a write and could not be indexed at all.
  const order =
    options.sort === 'popular'
      ? [desc(posts.hotScore), desc(posts.createdAt), desc(posts.id)]
      : [desc(posts.createdAt), desc(posts.id)];

  const [rows, [totalRow]] = await Promise.all([
    baseQuery(executor)
      .where(where)
      .orderBy(...order)
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor.select({ value: count() }).from(posts).where(where),
  ]);

  return {
    items: rows.map((r) => normalise(r as Record<string, unknown>)),
    total: Number(totalRow?.value ?? 0),
  };
}

export async function findPostById(
  id: string,
  viewer: Viewer,
  executor: Executor = db,
): Promise<PostRow | null> {
  const rows = await baseQuery(executor)
    .where(and(eq(posts.id, id), postVisibilityPredicate(viewer)))
    .limit(1);

  const row = rows[0];
  return row ? normalise(row as Record<string, unknown>) : null;
}

/** Unscoped read, for authorisation decisions that must distinguish 404 from 403. */
export async function findPostUnscoped(id: string, executor: Executor = db): Promise<PostRow | null> {
  const rows = await baseQuery(executor)
    .where(and(eq(posts.id, id), isNull(posts.deletedAt)))
    .limit(1);

  const row = rows[0];
  return row ? normalise(row as Record<string, unknown>) : null;
}

export async function insertPost(
  executor: Executor,
  values: {
    authorUserId: string;
    title: string | null;
    body: string;
    postKind: 'status' | 'link' | 'doc_share';
    visibility: 'public' | 'internal' | 'private';
    facultyId: string | null;
    linkUrl: string | null;
    sharedDocumentId: string | null;
  },
): Promise<{ id: string }> {
  const [row] = await executor.insert(posts).values(values).returning({ id: posts.id });
  return { id: row!.id };
}

export async function updatePost(
  executor: Executor,
  id: string,
  values: Partial<{
    title: string | null;
    body: string;
    visibility: 'public' | 'internal' | 'private';
    moderationState: 'visible' | 'hidden' | 'removed';
  }>,
): Promise<void> {
  await executor
    .update(posts)
    .set({ ...values, editedAt: new Date(), updatedAt: new Date() })
    .where(eq(posts.id, id));
}

export async function softDeletePost(executor: Executor, id: string): Promise<void> {
  await executor
    .update(posts)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(posts.id, id));
}

// --- Tags --------------------------------------------------------------------

export async function upsertTags(executor: Executor, names: string[]): Promise<string[]> {
  const ids: string[] = [];

  for (const name of names) {
    const slug = name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase()
      .replace(/[^a-z0-9+#.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);

    if (!slug) continue;

    const [row] = await executor
      .insert(tags)
      .values({ slug, name })
      .onConflictDoUpdate({ target: tags.slug, set: { name } })
      .returning({ id: tags.id });

    if (row) ids.push(row.id);
  }

  return ids;
}

export async function replacePostTags(
  executor: Executor,
  postId: string,
  tagIds: string[],
): Promise<void> {
  await executor.delete(postTags).where(eq(postTags.postId, postId));
  if (tagIds.length === 0) return;
  await executor
    .insert(postTags)
    .values(tagIds.map((tagId) => ({ postId, tagId })))
    .onConflictDoNothing();
}

export async function findPostTags(postId: string, executor: Executor = db) {
  return executor
    .select({ id: tags.id, slug: tags.slug, name: tags.name })
    .from(postTags)
    .innerJoin(tags, eq(tags.id, postTags.tagId))
    .where(eq(postTags.postId, postId))
    .orderBy(tags.name);
}

/** Tag ids for many posts at once — avoids an N+1 on a list page. */
export async function findTagsForPosts(
  postIds: string[],
  executor: Executor = db,
): Promise<Map<string, { id: string; slug: string; name: string }[]>> {
  if (postIds.length === 0) return new Map();

  const rows = await executor
    .select({
      postId: postTags.postId,
      id: tags.id,
      slug: tags.slug,
      name: tags.name,
    })
    .from(postTags)
    .innerJoin(tags, eq(tags.id, postTags.tagId))
    .where(inArray(postTags.postId, postIds));

  const map = new Map<string, { id: string; slug: string; name: string }[]>();
  for (const row of rows) {
    const list = map.get(row.postId) ?? [];
    list.push({ id: row.id, slug: row.slug, name: row.name });
    map.set(row.postId, list);
  }
  return map;
}

// --- Likes, for the viewer's own state ---------------------------------------

/**
 * Which of these posts the viewer has liked.
 *
 * One query for the whole page rather than one per post. A 20-post page doing
 * 20 existence checks is the classic list-page N+1, and it is invisible until
 * the page is slow.
 */
export async function findLikedPostIds(
  postIds: string[],
  userId: string | null,
  executor: Executor = db,
): Promise<Set<string>> {
  if (!userId || postIds.length === 0) return new Set();

  const rows = await executor
    .select({ postId: postLikes.postId })
    .from(postLikes)
    .where(
      and(
        eq(postLikes.userId, userId),
        inArray(postLikes.postId, postIds),
        isNull(postLikes.deletedAt),
      ),
    );

  return new Set(rows.map((r) => r.postId));
}
