import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, apiWithMeta } from './api-client';

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
  return useQuery({
    queryKey: ['social', 'post', postId],
    queryFn: () => api.get<Post>(`/posts/${postId}`),
    // No id means the route has not resolved yet, not a missing post. Fetching
    // `/posts/undefined` would 400 and render an error for a page that is
    // about to load correctly.
    enabled: Boolean(postId),
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

export function useUnreadCount() {
  return useQuery({
    queryKey: ['social', 'notifications', 'unread'],
    queryFn: () => api.get<{ unread: number }>('/notifications/unread-count'),
    // Polled while the tab is visible. The endpoint answers 304 when nothing
    // changed, so an idle tab transfers headers only — which is what makes a
    // short interval affordable.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
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

export interface CollectionItem {
  id: string;
  note: string | null;
  position: number;
  addedAt: string;
  target: {
    type: 'document' | 'post' | 'collection';
    id: string;
    title: string;
    owner: { id: string; displayName: string; avatarUrl: string | null };
    visibility: string;
    fileKind: string | null;
    sizeBytes: number | null;
    stats: { likes: number; comments: number; items: number };
  };
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

export function useMyCollections(filters: { page?: number; limit?: number } = {}) {
  return useQuery({
    queryKey: ['social', 'collections', 'mine', filters],
    queryFn: async () => {
      const { data, meta } = await apiWithMeta<Collection[]>(`/collections/mine${qs(filters)}`);
      return { collections: data, meta: meta as unknown as PaginatedMeta };
    },
  });
}

export function useCollection(collectionId: string | undefined, page = 1) {
  return useQuery({
    queryKey: ['social', 'collection', collectionId, page],
    queryFn: async () => {
      const { data, meta } = await apiWithMeta<Collection>(
        `/collections/${collectionId}?page=${page}&limit=50`,
      );
      return { collection: data, meta: meta as unknown as PaginatedMeta };
    },
    // No id means the route has not resolved yet, not a missing collection.
    enabled: Boolean(collectionId),
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
