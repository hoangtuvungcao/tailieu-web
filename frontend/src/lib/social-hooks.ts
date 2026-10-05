import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, apiWithMeta } from './api-client';
import { useSessionSettled } from './auth';

/**
 * Social data hooks.
 *
 * Keys are per-filter so paging and filtering cache separately, and mutations
 * invalidate only what they affect — a like should not evict the whole feed
 * cache and force a refetch of every page the reader has scrolled through.
 */

export interface Post {
  id: string;
  title: string | null;
  body: string;
  postKind: string;
  visibility: string;
  linkUrl: string | null;
  sharedDocumentId: string | null;
  author: { id: string; displayName: string; avatarUrl: string | null };
  stats: { likes: number; comments: number; bookmarks: number; hotScore: number };
  tags: { id: string; slug: string; name: string }[];
  likedByViewer: boolean;
  createdAt: string;
  editedAt: string | null;
  permissions: { canEdit: boolean; canDelete: boolean; canModerate: boolean };
}

export interface PaginatedMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface FeedFilters {
  sort?: 'newest' | 'popular';
  following?: boolean;
  authorUserId?: string;
  facultyId?: string;
  page?: number;
  limit?: number;
}

function qs(filters: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function usePosts(filters: FeedFilters) {
  return useQuery({
    queryKey: ['social', 'posts', filters],
    queryFn: async () => {
      const { data, meta } = await apiWithMeta<Post[]>(
        `/posts${qs({ ...filters, following: filters.following ? 'true' : undefined })}`,
      );
      return { posts: data, meta: meta as unknown as PaginatedMeta };
    },
  });
}

/**
 * The community feed, walked by keyset cursor.
 *
 * A separate hook from `usePosts` rather than a flag on it, because the two
 * genuinely return different things: this one has no total — a cursor never
 * counts — and accumulates pages, while `usePosts` answers "page 3 of 12" for a
 * list that is not moving underneath the reader. One hook with a mode switch
 * would have to lie about one of the two.
 *
 * No `page` in the request is what selects cursor mode on the server, so this
 * must never send one.
 */
export function useFeed(filters: Omit<FeedFilters, 'page' | 'cursor'>) {
  return useInfiniteQuery({
    queryKey: ['social', 'posts', 'feed', filters],
    queryFn: async ({ pageParam }) => {
      const { data, meta } = await apiWithMeta<Post[]>(
        `/posts${qs({
          ...filters,
          following: filters.following ? 'true' : undefined,
          cursor: pageParam as string | undefined,
          limit: filters.limit ?? 15,
        })}`,
      );
      return {
        posts: data,
        nextCursor: (meta as { nextCursor?: string | null }).nextCursor ?? null,
      };
    },
    initialPageParam: undefined as string | undefined,
    // Null means the server has nothing after this page; `undefined` is what
    // react-query reads as "stop".
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useCreatePost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { body: string; visibility: string; tags?: string[] }) =>
      api.post<Post>('/posts', {
        body: input.body,
        visibility: input.visibility,
        postKind: 'status',
        tags: input.tags ?? [],
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['social', 'posts'] });
    },
  });
}

/**
 * Like, with the desired state stated explicitly.
 *
 * The API takes `{ liked: boolean }` rather than toggling, precisely so a
 * retried request cannot undo itself. The client passes the state it wants
 * based on what it is rendering — which is also what makes the optimistic
 * update below safe.
 */
export function useSetLike() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { postId: string; liked: boolean }) =>
      api.put<{ liked: boolean; likeCount: number }>(`/likes/post/${input.postId}`, {
        liked: input.liked,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['social', 'posts'] });
    },
  });
}

export function usePost(postId: string | undefined) {
  const settled = useSessionSettled();
  return useQuery({
    queryKey: ['social', 'post', postId],
    queryFn: () => api.get<Post>(`/posts/${postId}`),
    // No id means the route has not resolved yet, not a missing post. Fetching
    // `/posts/undefined` would 400 and render an error for a page that is
    // about to load correctly. `settled` covers the other half: a post that is
    // not public answers 404 to an anonymous caller, so asking before the
    // session is restored shows "not found" for a post that is right there.
    enabled: Boolean(postId) && settled,
  });
}

export function useDeletePost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (postId: string) => api.delete(`/posts/${postId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['social', 'posts'] });
    },
  });
}

// --- Comments ----------------------------------------------------------------

export interface Comment {
  id: string;
  body: string;
  depth: number;
  parentCommentId: string | null;
  author: { id: string; displayName: string; avatarUrl: string | null };
  stats: { likes: number; replies: number };
  likedByViewer: boolean;
  /**
   * The comment was removed; `body` is empty and `author` is a placeholder.
   *
   * The row is still returned because it holds its replies in place — dropping
   * it would take every live reply beneath it out of the thread.
   */
  deleted: boolean;
  createdAt: string;
  editedAt: string | null;
  permissions: { canEdit: boolean; canDelete: boolean };
  /** Present only on top-level comments; the server groups the thread. */
  replies?: Comment[];
}

/**
 * Comments for one target.
 *
 * The server returns a flat page that it has already grouped into top-level
 * comments with their `replies` attached, so the client renders the tree
 * without a second request per comment. Listing is always scoped by target —
 * there is no cross-target comment list to request.
 */
export function useComments(targetType: 'post' | 'document', targetId: string | undefined) {
  return useQuery({
    queryKey: ['social', 'comments', targetType, targetId],
    queryFn: async () => {
      const { data, meta } = await apiWithMeta<Comment[]>(
        `/comments?targetType=${targetType}&targetId=${targetId}&limit=50`,
      );
      return { comments: data, meta: meta as unknown as PaginatedMeta };
    },
    enabled: Boolean(targetId),
  });
}

export function useCreateComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      targetType: 'post' | 'document';
      targetId: string;
      body: string;
      parentCommentId?: string | null;
    }) => api.post<Comment>('/comments', input),
    onSuccess: (_comment, input) => {
      void queryClient.invalidateQueries({
        queryKey: ['social', 'comments', input.targetType, input.targetId],
      });
      // The comment count on the post card is derived from the post row, so a
      // new comment makes the cached post stale.
      if (input.targetType === 'post') {
        void queryClient.invalidateQueries({ queryKey: ['social', 'post', input.targetId] });
        void queryClient.invalidateQueries({ queryKey: ['social', 'posts'] });
      }
    },
  });
}

export function useDeleteComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      commentId: string;
      targetType: 'post' | 'document';
      targetId: string;
    }) => api.delete(`/comments/${input.commentId}`),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({
        queryKey: ['social', 'comments', input.targetType, input.targetId],
      });
      if (input.targetType === 'post') {
        void queryClient.invalidateQueries({ queryKey: ['social', 'post', input.targetId] });
      }
    },
  });
}

/**
 * Like a comment.
 *
 * Same explicit-state contract as posts, and the same endpoint shape — the
 * likes module keys on `(target, id)`, so a comment like is not a separate
 * route with its own semantics.
 */
export function useSetCommentLike() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { commentId: string; liked: boolean }) =>
      api.put<{ liked: boolean; likeCount: number }>(`/likes/comment/${input.commentId}`, {
        liked: input.liked,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['social', 'comments'] });
    },
  });
}

/**
 * The unread badge count.
 *
 * `enabled` is required rather than optional, for the same reason `useForYou`
 * requires it: the endpoint answers 401 without a session. The header renders
 * the bell only when signed in, but "only render it" was not enough — the hook
 * was called unconditionally and fired before the session was restored on a
 * hard reload, so every reload of every page logged a 401 for a signed-in user.
 * Gating the query is what actually stops the request.
 */
export function useUnreadCount(enabled: boolean) {
  return useQuery({
    queryKey: ['social', 'notifications', 'unread'],
    queryFn: () => api.get<{ unread: number }>('/notifications/unread-count'),
    // Polled while the tab is visible. The endpoint answers 304 when nothing
    // changed, so an idle tab transfers headers only — which is what makes a
    // short interval affordable.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
    enabled,
  });
}

// =============================================================================
// Notifications
// =============================================================================

export interface Notification {
  id: string;
  kind: string;
  /** What the notification points at. Null only for system notifications. */
  targetType: string | null;
  targetId: string | null;
  /**
   * How many events this one row stands for.
   *
   * A thousand likes on a post are one row reading "A và 999 người khác", not a
   * thousand rows — the server collapses repeats on the thing they share.
   */
  aggregationCount: number;
  readAt: string | null;
  createdAt: string;
  /**
   * Actor identity, and nothing else.
   *
   * The server deliberately does not snapshot the target's title into the
   * payload: a notification holding a copy would keep announcing a document the
   * recipient has since lost access to. So a row says who and what kind, and
   * the target is only ever resolved by opening the link.
   */
  actorName: string | null;
  actorAvatar: string | null;
}

export function useNotifications(page = 1) {
  return useQuery({
    queryKey: ['social', 'notifications', 'list', page],
    queryFn: async () => {
      const { data, meta } = await apiWithMeta<Notification[]>(
        `/notifications?page=${page}&limit=30`,
      );
      return { notifications: data, meta: meta as unknown as PaginatedMeta };
    },
  });
}

/**
 * Both mutations invalidate the whole `['social','notifications']` prefix,
 * which includes the polled `unread` key — so the header badge and the list
 * cannot end up disagreeing about what has been read.
 */
export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (notificationId: string) =>
      api.post<{ read: boolean; unread: number }>(`/notifications/${notificationId}/read`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['social', 'notifications'] });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ marked: number; unread: number }>('/notifications/read-all'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['social', 'notifications'] });
    },
  });
}

// =============================================================================
// Collections
// =============================================================================

export interface Collection {
  id: string;
  title: string;
  description: string | null;
  visibility: string;
  coverDocumentId: string | null;
  owner: { id: string; displayName: string; avatarUrl: string | null };
  /**
   * The number of items *this viewer* can see — not the collection's true size.
   *
   * The API computes it per request for that reason: a public collection
   * holding one private document would otherwise announce two items above a
   * list of one.
   */
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  permissions: { canEdit: boolean; canDelete: boolean; canAddItem: boolean };
  /**
   * Present on the detail response only, and already filtered to what this
   * viewer may see. The list endpoints omit it rather than sending an empty
   * array, which would read as "this collection has no items".
   */
  items?: CollectionItem[];
}

/**
 * The card for a pointer, as rendered in a list.
 *
 * Declared once because a collection item and a bookmark show the same thing
 * about the same kinds of target — mirrors `TargetSummary` on the server, which
 * is shared for exactly the same reason.
 */
export interface TargetSummary {
  type: 'document' | 'post' | 'collection';
  id: string;
  title: string;
  owner: { id: string; displayName: string; avatarUrl: string | null };
  visibility: string;
  fileKind: string | null;
  sizeBytes: number | null;
  stats: { likes: number; comments: number; items: number };
}

export interface CollectionItem {
  id: string;
  note: string | null;
  position: number;
  addedAt: string;
  target: TargetSummary;
}

export function useCollections(filters: { q?: string; page?: number; limit?: number } = {}) {
  return useQuery({
    queryKey: ['social', 'collections', filters],
    queryFn: async () => {
      const { data, meta } = await apiWithMeta<Collection[]>(`/collections${qs(filters)}`);
      return { collections: data, meta: meta as unknown as PaginatedMeta };
    },
  });
}

/**
 * The signed-in user's own collections.
 *
 * `enabled` is required rather than optional, for the same reason
 * `useUnreadCount` and `useForYou` require it: `/collections/mine` answers 401
 * without a session, because "mine" has no meaning without an account.
 *
 * This one is easy to get wrong, because the page it lives on is public. The
 * discover tab is open to everyone, so the page cannot simply sit behind
 * `RequireAuth` — but calling the hook unconditionally meant a request that
 * could only ever be refused went out on every visit, signed in or not, and the
 * browser logged the 401 each time.
 */
export function useMyCollections(
  filters: { page?: number; limit?: number } = {},
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['social', 'collections', 'mine', filters],
    queryFn: async () => {
      const { data, meta } = await apiWithMeta<Collection[]>(`/collections/mine${qs(filters)}`);
      return { collections: data, meta: meta as unknown as PaginatedMeta };
    },
    enabled,
  });
}

export function useCollection(collectionId: string | undefined, page = 1) {
  const settled = useSessionSettled();
  return useQuery({
    queryKey: ['social', 'collection', collectionId, page],
    queryFn: async () => {
      const { data, meta } = await apiWithMeta<Collection>(
        `/collections/${collectionId}?page=${page}&limit=50`,
      );
      return { collection: data, meta: meta as unknown as PaginatedMeta };
    },
    // No id means the route has not resolved yet, not a missing collection.
    // `settled` because a private collection answers 404 to an anonymous
    // caller, which is indistinguishable from "deleted" — see
    // `useSessionSettled`.
    enabled: Boolean(collectionId) && settled,
  });
}

export function useCreateCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { title: string; description?: string | null; visibility: string }) =>
      api.post<Collection>('/collections', {
        title: input.title,
        description: input.description ?? null,
        visibility: input.visibility,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['social', 'collections'] });
    },
  });
}

export function useUpdateCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      collectionId: string;
      title?: string;
      description?: string | null;
      visibility?: string;
    }) =>
      api.patch<Collection>(`/collections/${input.collectionId}`, {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      }),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({
        queryKey: ['social', 'collection', input.collectionId],
      });
      void queryClient.invalidateQueries({ queryKey: ['social', 'collections'] });
    },
  });
}

export function useDeleteCollection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (collectionId: string) => api.delete(`/collections/${collectionId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['social', 'collections'] });
    },
  });
}

export function useAddCollectionItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      collectionId: string;
      targetType: 'document' | 'post' | 'collection';
      targetId: string;
      note?: string | null;
    }) =>
      api.post<CollectionItem>(`/collections/${input.collectionId}/items`, {
        targetType: input.targetType,
        targetId: input.targetId,
        note: input.note ?? null,
      }),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({
        queryKey: ['social', 'collection', input.collectionId],
      });
      void queryClient.invalidateQueries({ queryKey: ['social', 'collections'] });
    },
  });
}

export function useRemoveCollectionItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { collectionId: string; itemId: string }) =>
      api.delete(`/collections/${input.collectionId}/items/${input.itemId}`),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({
        queryKey: ['social', 'collection', input.collectionId],
      });
      void queryClient.invalidateQueries({ queryKey: ['social', 'collections'] });
    },
  });
}

export function useReorderCollectionItems() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { collectionId: string; itemIds: string[] }) =>
      api.patch(`/collections/${input.collectionId}/items/order`, { itemIds: input.itemIds }),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({
        queryKey: ['social', 'collection', input.collectionId],
      });
    },
  });
}

// =============================================================================
// Profiles and follows
// =============================================================================

export interface ProfileBadge {
  code: string;
  name: string;
  description: string | null;
  icon: string | null;
  tier: number;
  category: string;
  awardedAt: string;
}

export interface PublicProfile {
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
  /**
   * Every number here is what *this viewer* can see, not the account's totals.
   * The profile links to these lists, and both apply the same predicate.
   */
  stats: { posts: number; documents: number; followers: number; following: number };
  /**
   * All-time, and it can be negative — a penalised account goes below zero
   * rather than being clamped at it. Not viewer-filtered, unlike the counts:
   * reputation is not content.
   */
  reputation: number;
  badges: ProfileBadge[];
  isFollowedByViewer: boolean;
  isSelf: boolean;
  permissions: { canFollow: boolean };
}

export function useProfile(userId: string | undefined) {
  const settled = useSessionSettled();
  return useQuery({
    queryKey: ['social', 'profile', userId],
    queryFn: () => api.get<PublicProfile>(`/users/${userId}`),
    // No id means the route has not resolved yet, not a missing profile.
    // `settled` for the same reason as the other detail hooks: a profile that
    // is not visible to anonymous callers answers 404, and a 404 is not
    // retried, so asking too early turns a working link into a dead end.
    enabled: Boolean(userId) && settled,
  });
}

export interface FollowState {
  followers: number;
  following: number;
  isFollowing: boolean;
}

/**
 * Whether the viewer follows this account, with their counts.
 *
 * Fetched rather than passed down, so a follow button rendered inside a list is
 * correct without every list having to load the relationships first. Public —
 * a signed-out caller gets `isFollowing: false`.
 */
export function useFollowState(userId: string | undefined) {
  return useQuery({
    queryKey: ['social', 'follow', userId],
    queryFn: () => api.get<FollowState>(`/follows/${userId}`),
    enabled: Boolean(userId),
  });
}

export function useSetFollow() {
  const queryClient = useQueryClient();
  return useMutation({
    // Explicit desired state, matching likes and bookmarks: a retried request
    // cannot undo itself the way a toggle would.
    mutationFn: (input: { userId: string; following: boolean }) =>
      api.put<{ following: boolean; followers: number }>(`/follows/${input.userId}`, {
        following: input.following,
      }),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: ['social', 'follow', input.userId] });
      // The profile header carries the same numbers and the same flag.
      void queryClient.invalidateQueries({ queryKey: ['social', 'profile', input.userId] });
      // The "following" feed is defined by this relationship.
      void queryClient.invalidateQueries({ queryKey: ['social', 'posts'] });
    },
  });
}

export interface FollowUser {
  id: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  followedAt: string;
}

function useFollowList(
  kind: 'followers' | 'following',
  userId: string | undefined,
  page: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['social', kind, userId, page],
    queryFn: async () => {
      const { data, meta } = await apiWithMeta<FollowUser[]>(
        `/follows/${userId}/${kind}?page=${page}&limit=30`,
      );
      return { users: data, meta: meta as unknown as PaginatedMeta };
    },
    // `enabled` lets a tabbed profile fetch only the list being looked at,
    // rather than both on every open.
    enabled: Boolean(userId) && enabled,
  });
}

export function useFollowers(userId: string | undefined, page = 1, enabled = true) {
  return useFollowList('followers', userId, page, enabled);
}

export function useFollowing(userId: string | undefined, page = 1, enabled = true) {
  return useFollowList('following', userId, page, enabled);
}

// =============================================================================
// Leaderboards
// =============================================================================

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  score: number;
  isViewer: boolean;
}

export interface Leaderboard {
  /** `'2026-10'`. A month key, not a date — see the note on the API. */
  periodKey: string;
  scope: 'university' | 'faculty' | 'program';
  scopeId: string | null;
  entries: LeaderboardEntry[];
  /**
   * The viewer's own position, which may be outside the returned page — or null
   * when they are not on the board at all. Not `rank: 0`: somebody with no
   * points has no rank, and showing one invites the question of what it means.
   */
  viewer: { rank: number; score: number } | null;
}

export function useLeaderboard(filters: {
  period?: string;
  scope?: 'university' | 'faculty' | 'program';
  scopeId?: string;
}) {
  return useQuery({
    queryKey: ['social', 'leaderboard', filters],
    queryFn: () => api.get<Leaderboard>(`/leaderboards${qs(filters)}`),
  });
}

// =============================================================================
// Ranked feed
// =============================================================================

export interface RankedFeed {
  posts: Post[];
  /**
   * Which ranking actually ran.
   *
   * `popular-fallback` means Redis could not answer and the server used a
   * bounded SQL query instead. The page shows the same heading either way —
   * "recently popular" is an honest description of both — but a caller that
   * wants to explain a surprising order can tell which one produced it.
   */
  ranking: 'trending' | 'popular-fallback' | 'heuristic';
}

export function useTrending(limit = 20) {
  return useQuery({
    queryKey: ['social', 'feed', 'trending', limit],
    queryFn: async () => {
      const { data, meta } = await apiWithMeta<Post[]>(`/feed/trending?limit=${limit}`);
      return {
        posts: data,
        ranking: (meta as { ranking: RankedFeed['ranking'] }).ranking,
      };
    },
  });
}

/**
 * The "For You" tab.
 *
 * `enabled` is required rather than optional because the endpoint answers 401
 * without an account — every term in the heuristic needs a viewer. The UI only
 * offers the tab when signed in, so the request is never sent otherwise.
 */
export function useForYou(limit = 20, enabled = true) {
  return useQuery({
    queryKey: ['social', 'feed', 'for-you', limit],
    queryFn: async () => {
      const { data, meta } = await apiWithMeta<Post[]>(`/feed/for-you?limit=${limit}`);
      return {
        posts: data,
        ranking: (meta as { ranking: RankedFeed['ranking'] }).ranking,
      };
    },
    enabled,
  });
}

// =============================================================================
// Bookmarks
// =============================================================================

export interface Bookmark {
  id: string;
  folder: string | null;
  savedAt: string;
  target: TargetSummary;
}

export function useBookmarks(filters: { folder?: string; page?: number } = {}) {
  return useQuery({
    queryKey: ['social', 'bookmarks', 'list', filters],
    queryFn: async () => {
      const { data, meta } = await apiWithMeta<Bookmark[]>(
        `/bookmarks${qs({ ...filters, limit: 50 })}`,
      );
      return { bookmarks: data, meta: meta as unknown as PaginatedMeta };
    },
  });
}

/**
 * The folders this viewer has actually used, with counts.
 *
 * The counts are computed with the same visibility predicate as the list, so a
 * folder can never advertise more items than opening it will show.
 */
export function useBookmarkFolders() {
  return useQuery({
    queryKey: ['social', 'bookmarks', 'folders'],
    queryFn: () => api.get<{ folder: string; total: number }[]>('/bookmarks/folders'),
  });
}

/**
 * Whether the viewer has bookmarked this thing.
 *
 * Safe to call while signed out — the endpoint uses optional auth and answers
 * `{ bookmarked: false }` — which is what lets one button serve both states
 * without every call site branching on authentication.
 */
export function useBookmarkState(
  target: 'document' | 'post' | 'collection',
  id: string | undefined,
) {
  return useQuery({
    queryKey: ['social', 'bookmarks', 'state', target, id],
    queryFn: () => api.get<{ bookmarked: boolean }>(`/bookmarks/${target}/${id}`),
    enabled: Boolean(id),
  });
}

export function useSetBookmark() {
  const queryClient = useQueryClient();
  return useMutation({
    // Explicit desired state, matching likes and follows: a retried request
    // cannot undo itself the way a toggle would.
    mutationFn: (input: {
      target: 'document' | 'post' | 'collection';
      id: string;
      bookmarked: boolean;
      folder?: string | null;
    }) =>
      api.put<{ bookmarked: boolean }>(`/bookmarks/${input.target}/${input.id}`, {
        bookmarked: input.bookmarked,
        // Omitted rather than sent as null when unspecified. The server keeps an
        // existing folder when the field is absent, so toggling from a detail
        // page does not silently unfiled something the user had filed.
        ...(input.folder !== undefined ? { folder: input.folder } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['social', 'bookmarks'] });
    },
  });
}
