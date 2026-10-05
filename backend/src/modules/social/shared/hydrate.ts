import { and, eq, inArray } from 'drizzle-orm';

import { db, type Database } from '../../../db/client.js';
import { collections, documents, posts, users } from '../../../db/schema/index.js';
import {
  collectionVisibilityPredicate,
  documentVisibilityPredicate,
  postVisibilityPredicate,
  type Viewer,
} from './visibility.js';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Tx | typeof db;

/**
 * Loading the rows behind a polymorphic pointer.
 *
 * Three features point at things by `(target_type, target_id)` — collection
 * items, bookmarks, and notifications — and every one of them has the same two
 * obligations: load the pointed-at rows in one query per kind rather than one
 * per pointer, and apply the *owning module's* visibility predicate while doing
 * it.
 *
 * That second obligation is the whole reason this is one file. A polymorphic
 * pointer has no foreign key, so nothing but a re-check at read time keeps a
 * bookmark list from printing the title of a document the reader cannot open.
 * Two copies of those three predicates would be one copy too many, and the copy
 * that drifts is always the one nobody re-read.
 *
 * Callers get back maps keyed by id. Anything missing is meaningful — it means
 * the pointer outlived the reader's access to its target — and callers decide
 * what to do about it rather than receiving a silently shorter list.
 */

export interface DocumentTargetRow {
  id: string;
  title: string;
  visibility: string;
  fileKind: string | null;
  sizeBytes: number | null;
  ownerId: string;
  ownerName: string | null;
  ownerAvatar: string | null;
}

export interface PostTargetRow {
  id: string;
  title: string | null;
  body: string;
  visibility: string;
  likeCount: number;
  commentCount: number;
  authorId: string;
  authorName: string | null;
  authorAvatar: string | null;
}

export interface CollectionTargetRow {
  id: string;
  title: string;
  visibility: string;
  itemCount: number;
  ownerId: string;
  ownerName: string | null;
  ownerAvatar: string | null;
}

export async function hydrateDocuments(
  ids: string[],
  viewer: Viewer,
  executor: Executor = db,
): Promise<Map<string, DocumentTargetRow>> {
  if (ids.length === 0) return new Map();

  const rows = await executor
    .select({
      id: documents.id,
      title: documents.title,
      visibility: documents.visibility,
      fileKind: documents.fileKind,
      sizeBytes: documents.sizeBytes,
      ownerId: users.id,
      ownerName: users.displayName,
      ownerAvatar: users.avatarUrl,
    })
    .from(documents)
    .innerJoin(users, eq(users.id, documents.ownerUserId))
    .where(and(inArray(documents.id, ids), documentVisibilityPredicate(viewer)));

  return new Map(rows.map((r) => [r.id, r]));
}

export async function hydratePosts(
  ids: string[],
  viewer: Viewer,
  executor: Executor = db,
): Promise<Map<string, PostTargetRow>> {
  if (ids.length === 0) return new Map();

  const rows = await executor
    .select({
      id: posts.id,
      title: posts.title,
      body: posts.body,
      visibility: posts.visibility,
      likeCount: posts.likeCount,
      commentCount: posts.commentCount,
      authorId: users.id,
      authorName: users.displayName,
      authorAvatar: users.avatarUrl,
    })
    .from(posts)
    .innerJoin(users, eq(users.id, posts.authorUserId))
    .where(and(inArray(posts.id, ids), postVisibilityPredicate(viewer)));

  return new Map(
    rows.map((r) => [
      r.id,
      { ...r, likeCount: Number(r.likeCount), commentCount: Number(r.commentCount) },
    ]),
  );
}

export async function hydrateCollections(
  ids: string[],
  viewer: Viewer,
  executor: Executor = db,
): Promise<Map<string, CollectionTargetRow>> {
  if (ids.length === 0) return new Map();

  const rows = await executor
    .select({
      id: collections.id,
      title: collections.title,
      visibility: collections.visibility,
      itemCount: collections.itemCount,
      ownerId: users.id,
      ownerName: users.displayName,
      ownerAvatar: users.avatarUrl,
    })
    .from(collections)
    .innerJoin(users, eq(users.id, collections.ownerUserId))
    .where(and(inArray(collections.id, ids), collectionVisibilityPredicate(viewer)));

  return new Map(rows.map((r) => [r.id, { ...r, itemCount: Number(r.itemCount) }]));
}

/**
 * Split a page of pointers by kind, so each hydrator gets only its own ids.
 *
 * Every caller was writing this loop, and it is the kind of loop that is easy to
 * get subtly wrong — a pointer filed under the wrong bucket silently vanishes
 * from the result.
 */
export function groupByTargetKind<T extends { targetType: string; targetId: string }>(
  pointers: T[],
): { document: string[]; post: string[]; collection: string[] } {
  const ids = { document: [] as string[], post: [] as string[], collection: [] as string[] };
  for (const pointer of pointers) {
    // Unknown kinds are dropped rather than guessed at. The enum is checked at
    // write time, so this can only fire if a kind is added without a hydrator.
    const bucket = ids[pointer.targetType as keyof typeof ids];
    if (bucket) bucket.push(pointer.targetId);
  }
  return ids;
}

// =============================================================================
// Summarising
// =============================================================================

/**
 * The card every "somebody pointed at something" list renders.
 *
 * Collections and bookmarks show the same thing about a target, so they show
 * the same shape. Two hand-written mappers would be two places for "what a post
 * card says" to drift — and the one thing that must never differ between them is
 * which fields are safe to expose.
 */
export interface TargetSummary {
  type: 'document' | 'post' | 'collection';
  id: string;
  title: string;
  /** What the card's second line says: the author or owner. */
  owner: { id: string; displayName: string; avatarUrl: string | null };
  visibility: string;
  fileKind: string | null;
  sizeBytes: number | null;
  stats: { likes: number; comments: number; items: number };
}

/**
 * Load the targets behind a page of pointers, summarised for display.
 *
 * Three queries for the whole page, one per kind — never one per pointer.
 *
 * The result is keyed by **pointer** id rather than target id, so a caller pairs
 * each of its own rows with a summary and finds out which of them came back
 * empty. That matters because a target missing here passed the caller's write-time
 * check and its read-time filter but was refused by its owning module's predicate
 * — the two disagreeing is a bug, and a caller that just saw a shorter list
 * would never notice.
 */
export async function hydrateTargets(
  pointers: { id: string; targetType: string; targetId: string }[],
  viewer: Viewer,
): Promise<{ summaries: Map<string, TargetSummary>; missing: string[] }> {
  const idsBy = groupByTargetKind(pointers);

  const [documents, posts, nested] = await Promise.all([
    hydrateDocuments(idsBy.document, viewer),
    hydratePosts(idsBy.post, viewer),
    hydrateCollections(idsBy.collection, viewer),
  ]);

  const summaries = new Map<string, TargetSummary>();
  const missing: string[] = [];

  for (const pointer of pointers) {
    let summary: TargetSummary | null = null;

    if (pointer.targetType === 'document') {
      const row = documents.get(pointer.targetId);
      if (row) {
        summary = {
          type: 'document',
          id: row.id,
          title: row.title,
          owner: { id: row.ownerId, displayName: row.ownerName ?? ANON, avatarUrl: row.ownerAvatar },
          visibility: row.visibility,
          fileKind: row.fileKind,
          sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
          stats: { likes: 0, comments: 0, items: 0 },
        };
      }
    } else if (pointer.targetType === 'post') {
      const row = posts.get(pointer.targetId);
      if (row) {
        summary = {
          type: 'post',
          id: row.id,
          // A status post has no title. Falling back to its opening words keeps
          // every card the same shape rather than rendering a blank line where
          // a title should be.
          title: row.title ?? row.body.slice(0, 80),
          owner: { id: row.authorId, displayName: row.authorName ?? ANON, avatarUrl: row.authorAvatar },
          visibility: row.visibility,
          fileKind: null,
          sizeBytes: null,
          stats: { likes: row.likeCount, comments: row.commentCount, items: 0 },
        };
      }
    } else if (pointer.targetType === 'collection') {
      const row = nested.get(pointer.targetId);
      if (row) {
        summary = {
          type: 'collection',
          id: row.id,
          title: row.title,
          owner: { id: row.ownerId, displayName: row.ownerName ?? ANON, avatarUrl: row.ownerAvatar },
          visibility: row.visibility,
          fileKind: null,
          sizeBytes: null,
          // The stored counter, not a viewer-visible count. Computing a
          // per-viewer count here would mean another query inside the hydration
          // of a page, and the nested card is a link — the number is a hint of
          // size, not a promise about what the next page holds.
          stats: { likes: 0, comments: 0, items: row.itemCount },
        };
      }
    }

    if (summary) summaries.set(pointer.id, summary);
    else missing.push(pointer.id);
  }

  return { summaries, missing };
}

/** Shown when a row's owner has no display name set. */
const ANON = 'Người dùng ẩn danh';
