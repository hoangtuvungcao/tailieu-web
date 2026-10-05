import { and, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import { db, type Database } from '../../../db/client.js';
import { follows, postLikes, postTags, posts, tags, users } from '../../../db/schema/index.js';
import { toOffset, type PaginationInput } from '../../../lib/pagination.js';
import { postVisibilityPredicate, type Viewer } from '../shared/visibility.js';
import { encodeCursor } from '../../../lib/cursor.js';

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
  /** Keyset position. Only honoured for the `newest` sort — see `listPosts`. */
  cursor?: { createdAt: string; id: string } | null;
  /**
   * Whether the caller wants keyset paging.
   *
   * Explicit rather than inferred from `cursor` being present: the first page
   * of a walk has no cursor and still has to come back in cursor shape, or
   * there is no way to start one.
   */
  wantCursor?: boolean;
}

export interface PostPage {
  items: PostRow[];
  /** Present only when paging by cursor. */
  nextCursor: string | null;
  /** Present only when paging by offset, which is the only mode that counts. */
  total: number | null;
}

/**
 * Post list, by cursor or by offset.
 *
 * TWO PAGINATION MODES, and the reason is that they answer different questions.
 *
 * `cursor` is keyset pagination on `(created_at, id)`, served directly by
 * `posts_recent_idx`. It is what the feed uses: with OFFSET, a post published
 * while the reader is on page 2 shifts everything down and page 3 repeats a row
 * they already saw — which for a feed people leave open is not an edge case,
 * it is the normal case. The `id` tiebreaker matters because two posts can
 * share a millisecond, and comparing on the timestamp alone would skip or
 * repeat everything that landed in the same one.
 *
 * `page` remains for the browse-and-filter surfaces (a profile's posts, an
 * author filter) where the reader wants "1,247 results" and the result set is
 * not moving underneath them. That trade is argued in `lib/pagination.ts`.
 *
 * A cursor is IGNORED for the `popular` sort, deliberately. `hot_score` changes
 * with every like, so a position in that ordering is not stable — a cursor into
 * it would skip rows that moved up and repeat rows that moved down. Popular
 * pagination stays on offset, where a repeated row is possible and a silent
 * omission is not.
 */
export async function listPosts(
  options: PostListOptions,
  pagination: PaginationInput,
  viewer: Viewer,
  executor: Executor = db,
): Promise<PostPage> {
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

  const cursor = options.cursor ?? null;
  const keyset = Boolean(options.wantCursor) && options.sort !== 'popular';

  // Popular sorts on the stored engagement score, which carries no time term —
  // that is what makes it indexable. Recency is applied as a tiebreak rather
  // than folded into the score, because a stored score containing `now()` would
  // change without a write and could not be indexed at all.
  const order =
    options.sort === 'popular'
      ? [desc(posts.hotScore), desc(posts.createdAt), desc(posts.id)]
      : [desc(posts.createdAt), desc(posts.id)];

  if (keyset) {
    if (cursor) {
      // A row-value comparison, which Postgres matches against the composite
      // index rather than sorting and filtering.
      predicates.push(
        sql`(${posts.createdAt}, ${posts.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }

    const where = and(...predicates)!;

    // One row beyond the page, so "is there more" needs no second query. This
    // is the half of OFFSET that hurts most on a deep page: counting the whole
    // result set to render a number the reader is not looking at.
    const rows = await baseQuery(executor)
      .where(where)
      .orderBy(...order)
      .limit(pagination.limit + 1);

    const page = rows.slice(0, pagination.limit);
    const items = page.map((r) => normalise(r as Record<string, unknown>));
    const last = items.at(-1);

    return {
      items,
      nextCursor:
        rows.length > pagination.limit && last ? encodeCursor(last.createdAt, last.id) : null,
      total: null,
    };
  }

  const where = and(...predicates)!;

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
    nextCursor: null,
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

/**
 * Posts by id, filtered by the viewer's predicate, in the order they were given.
 *
 * Order is preserved rather than left to the planner: the ids come from a
 * trending list, and that list *is* the ranking. Rendering them in whatever
 * order `IN` happens to return would silently replace the ranking with an
 * arbitrary one.
 *
 * An id that does not come back is one this viewer may not see — normal here
 * rather than a bug, because something that trended an hour ago can have been
 * hidden or deleted since. Unlike a collection, a shorter trending list is the
 * honest answer rather than a signal that two filters disagree.
 */
export async function findPostsByIds(
  ids: string[],
  viewer: Viewer,
  executor: Executor = db,
): Promise<PostRow[]> {
  if (ids.length === 0) return [];

  const rows = await baseQuery(executor).where(
    and(inArray(posts.id, ids), postVisibilityPredicate(viewer)),
  );

  const byId = new Map(rows.map((r) => [r.id, normalise(r as Record<string, unknown>)]));
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is PostRow => Boolean(row));
}

/**
 * The SQL answer when Redis cannot provide one.
 *
 * Bounded to a recent window on purpose. `hot_score` is cumulative, so an
 * unbounded ordering returns the same all-time favourites forever and the
 * "trending" label becomes a lie. Bounded, it means "recently engaged with" —
 * a worse signal than the ZSET union, but an honest one, and it is served by
 * `posts_popular_idx`.
 */
export async function topByHotScore(
  limit: number,
  viewer: Viewer,
  days = 7,
  executor: Executor = db,
): Promise<PostRow[]> {
  const rows = await baseQuery(executor)
    .where(
      and(
        postVisibilityPredicate(viewer),
        sql`${posts.createdAt} > now() - (${days} * interval '1 day')`,
      ),
    )
    .orderBy(desc(posts.hotScore), desc(posts.id))
    .limit(limit);

  return rows.map((r) => normalise(r as Record<string, unknown>));
}

/**
 * "For You" candidates.
 *
 * THIS IS A HEURISTIC, NOT A RECOMMENDER. There is no embedder, no model and no
 * learned ranker here, and building one is out of scope for a stack that runs
 * on one laptop. The score is three readable terms:
 *
 *   +3  the author is somebody the viewer follows
 *   +2  the post is tagged with the viewer's own faculty
 *   +1  the post is in the current trending set
 *
 * …then engagement and recency as tiebreakers. Every term is something the
 * viewer could point at and explain, which is the property that makes it
 * honest to show. Calling it personalised would promise something this does not
 * do.
 *
 * A new account with no follows and no faculty scores everything at zero and
 * gets a recency-and-engagement feed. That is the correct degradation, not a
 * bug: there is nothing to personalise on yet.
 *
 * The sort term is computed, so it cannot be indexed and this sorts a bounded
 * window. That is affordable because the result is a short list, not a deep
 * cursor walk — if this ever needs paging, the score has to be materialised
 * first.
 */
export async function forYouCandidates(
  viewer: Viewer,
  trendIds: string[],
  limit: number,
  executor: Executor = db,
): Promise<PostRow[]> {
  const followBonus = viewer.userId
    ? sql`CASE WHEN EXISTS (
        SELECT 1 FROM follows f
         WHERE f.follower_user_id = ${viewer.userId}
           AND f.followee_user_id = ${posts.authorUserId}
           AND f.deleted_at IS NULL
      ) THEN 3 ELSE 0 END`
    : sql`0`;

  const facultyBonus = viewer.facultyId
    ? sql`CASE WHEN ${posts.facultyId} = ${viewer.facultyId}::uuid THEN 2 ELSE 0 END`
    : sql`0`;

  const trendBonus =
    trendIds.length > 0
      ? sql`CASE WHEN ${inArray(posts.id, trendIds)} THEN 1 ELSE 0 END`
      : sql`0`;

  const affinity = sql<number>`(${followBonus} + ${facultyBonus} + ${trendBonus})`;

  const rows = await executor
    .select({ ...postColumns, affinity })
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorUserId))
    .where(
      and(
        postVisibilityPredicate(viewer),
        // A month. Beyond that the feed is archaeology, and the window is what
        // keeps the sort affordable.
        sql`${posts.createdAt} > now() - interval '30 days'`,
      ),
    )
    .orderBy(desc(affinity), desc(posts.hotScore), desc(posts.createdAt), desc(posts.id))
    .limit(limit);

  return rows.map((r) => normalise(r as Record<string, unknown>));
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
