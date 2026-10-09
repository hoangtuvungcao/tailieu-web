import { and, asc, count, desc, eq, ilike, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import { db, type Database } from '../../../db/client.js';
import { collectionItems, collections, users } from '../../../db/schema/index.js';
import { toOffset, type PaginationInput } from '../../../lib/pagination.js';
import {
  collectionItemVisibleTo,
  collectionVisibilityPredicate,
  type Viewer,
} from '../shared/visibility.js';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Tx | typeof db;

/**
 * Collection data access.
 *
 * Two rules run through this file, and both exist because a collection is a
 * *container of pointers* rather than content in its own right:
 *
 *   1. NOTHING THAT RETURNS A COLLECTION SKIPS ITS PREDICATE. One collection
 *      read is unscoped — `findCollectionUnscoped` — and it exists solely so the
 *      write path can tell "does not exist" from "you may not touch this" and
 *      answer both with 404. It is named `Unscoped` so a grep for a leak
 *      surfaces it first.
 *
 *   2. ITEMS ARE FILTERED IN SQL, TWICE. `listItems` applies
 *      `collectionItemVisibleTo` so the page and its total agree with what the
 *      reader can see; `hydrate*` applies the owning module's predicate again
 *      when it loads the pointed-at rows. The second pass is not redundant
 *      belt-and-braces for its own sake — it means that a mistake in the first
 *      fails closed instead of printing a private document's title.
 */

const collectionColumns = {
  id: collections.id,
  ownerUserId: collections.ownerUserId,
  ownerName: users.displayName,
  ownerAvatar: users.avatarUrl,
  title: collections.title,
  description: collections.description,
  visibility: collections.visibility,
  coverDocumentId: collections.coverDocumentId,
  itemCount: collections.itemCount,
  followerCount: collections.followerCount,
  createdAt: collections.createdAt,
  updatedAt: collections.updatedAt,
};

export interface CollectionRow {
  id: string;
  ownerUserId: string;
  ownerName: string | null;
  ownerAvatar: string | null;
  title: string;
  description: string | null;
  visibility: 'public' | 'internal' | 'private';
  coverDocumentId: string | null;
  itemCount: number;
  followerCount: number;
  createdAt: Date | string;
  updatedAt: Date | string;
}

function normalise(row: Record<string, unknown>): CollectionRow {
  return {
    ...row,
    itemCount: Number(row.itemCount ?? 0),
    followerCount: Number(row.followerCount ?? 0),
  } as CollectionRow;
}

function baseQuery(executor: Executor) {
  return executor
    .select(collectionColumns)
    .from(collections)
    .innerJoin(users, eq(users.id, collections.ownerUserId));
}

// =============================================================================
// Collections
// =============================================================================

export interface CollectionListOptions {
  ownerUserId?: string;
  /** Case-insensitive title/description match. */
  q?: string;
}

/**
 * The discover list: collections the viewer is allowed to see.
 *
 * Note that `collectionVisibilityPredicate` already includes the viewer's own
 * private collections, so an owner browsing this list sees their drafts in it.
 * That is intended — the alternative is a user who cannot find their own
 * collection from the page that lists collections.
 */
export async function listCollections(
  options: CollectionListOptions,
  pagination: PaginationInput,
  viewer: Viewer,
  executor: Executor = db,
) {
  const predicates: SQL[] = [collectionVisibilityPredicate(viewer)];

  if (options.ownerUserId) predicates.push(eq(collections.ownerUserId, options.ownerUserId));

  if (options.q) {
    const pattern = `%${options.q}%`;
    predicates.push(
      sql`(${ilike(collections.title, pattern)} OR ${ilike(collections.description, pattern)})`,
    );
  }

  const where = and(...predicates)!;

  const [rows, [totalRow]] = await Promise.all([
    baseQuery(executor)
      .where(where)
      .orderBy(desc(collections.createdAt), desc(collections.id))
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor.select({ value: count() }).from(collections).where(where),
  ]);

  return {
    items: rows.map((r) => normalise(r as Record<string, unknown>)),
    total: Number(totalRow?.value ?? 0),
  };
}

/**
 * The owner's own collections, private included.
 *
 * Filtered on ownership rather than on the visibility predicate, because the
 * predicate's "own rows" clause and this are the same set expressed two ways
 * and only one of them can be the index scan this list wants.
 */
export async function listOwnCollections(
  userId: string,
  pagination: PaginationInput,
  executor: Executor = db,
) {
  const where = and(eq(collections.ownerUserId, userId), isNull(collections.deletedAt))!;

  const [rows, [totalRow]] = await Promise.all([
    baseQuery(executor)
      .where(where)
      .orderBy(desc(collections.updatedAt), desc(collections.id))
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor.select({ value: count() }).from(collections).where(where),
  ]);

  return {
    items: rows.map((r) => normalise(r as Record<string, unknown>)),
    total: Number(totalRow?.value ?? 0),
  };
}

export async function findCollectionById(
  id: string,
  viewer: Viewer,
  executor: Executor = db,
): Promise<CollectionRow | null> {
  const rows = await baseQuery(executor)
    .where(and(eq(collections.id, id), collectionVisibilityPredicate(viewer)))
    .limit(1);

  const row = rows[0];
  return row ? normalise(row as Record<string, unknown>) : null;
}

/**
 * Read a collection ignoring visibility — for authorization only.
 *
 * The single unscoped read in this file. It exists so `updateCollection` can
 * distinguish "no such collection" from "not yours" while answering both with
 * the same 404, and so a moderator's delete does not require them to be able to
 * *read* the collection first.
 */
export async function findCollectionUnscoped(
  id: string,
  executor: Executor = db,
): Promise<CollectionRow | null> {
  const rows = await baseQuery(executor)
    .where(and(eq(collections.id, id), isNull(collections.deletedAt)))
    .limit(1);

  const row = rows[0];
  return row ? normalise(row as Record<string, unknown>) : null;
}

/**
 * Is this owner already using this title?
 *
 * Checked ahead of the insert so the caller can return a readable conflict
 * instead of letting `collections_owner_title_uq` surface as a 500.
 *
 * The comparison is `lower(immutable_unaccent(title))`, matching the index
 * expression character for character. A plain `lower()` here would be worse
 * than no check at all: it would pass "ôn thi" through to an index that does
 * catch it, turning a clear conflict message into a raw constraint violation —
 * and on this cluster `lower()` is ASCII-only, so it would also miss cases the
 * index catches, making the two disagree in both directions.
 */
export async function findOwnedByTitle(
  ownerUserId: string,
  title: string,
  executor: Executor = db,
  excludeId?: string,
): Promise<{ id: string } | null> {
  const predicates: SQL[] = [
    eq(collections.ownerUserId, ownerUserId),
    sql`lower(immutable_unaccent(${collections.title})) = lower(immutable_unaccent(${title}))`,
    isNull(collections.deletedAt),
  ];
  if (excludeId) predicates.push(sql`${collections.id} <> ${excludeId}`);

  const rows = await executor
    .select({ id: collections.id })
    .from(collections)
    .where(and(...predicates))
    .limit(1);

  return rows[0] ?? null;
}

export async function insertCollection(
  executor: Executor,
  values: {
    ownerUserId: string;
    title: string;
    description: string | null;
    visibility: 'public' | 'internal' | 'private';
  },
): Promise<{ id: string }> {
  const [row] = await executor
    .insert(collections)
    .values(values)
    .returning({ id: collections.id });
  return { id: row!.id };
}

export async function updateCollection(
  executor: Executor,
  id: string,
  patch: Partial<{
    title: string;
    description: string | null;
    visibility: 'public' | 'internal' | 'private';
    coverDocumentId: string | null;
  }>,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await executor
    .update(collections)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(collections.id, id));
}

export async function softDeleteCollection(executor: Executor, id: string): Promise<void> {
  await executor
    .update(collections)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(collections.id, id));
}

// =============================================================================
// Items
// =============================================================================

export interface ItemRow {
  id: string;
  collectionId: string;
  targetType: 'document' | 'post' | 'collection';
  targetId: string;
  note: string | null;
  position: number;
  createdAt: Date | string;
}

const itemColumns = {
  id: collectionItems.id,
  collectionId: collectionItems.collectionId,
  targetType: collectionItems.targetType,
  targetId: collectionItems.targetId,
  note: collectionItems.note,
  position: collectionItems.position,
  createdAt: collectionItems.createdAt,
};

function itemWhere(collectionId: string, viewer: Viewer): SQL {
  return and(
    eq(collectionItems.collectionId, collectionId),
    isNull(collectionItems.deletedAt),
    // The predicate that makes a collection safe to share. A private document
    // parked in a public collection is filtered here, in SQL, before its id
    // ever reaches a hydration query.
    collectionItemVisibleTo(viewer),
  )!;
}

/**
 * The items the viewer may see, in curated order.
 *
 * `position` then `createdAt`: the manual order is the point of a collection,
 * and two items sharing a position — which a concurrent reorder can produce —
 * must still come back in a stable order or the list jitters between requests.
 */
export async function listItems(
  collectionId: string,
  viewer: Viewer,
  pagination: PaginationInput,
  executor: Executor = db,
) {
  const where = itemWhere(collectionId, viewer);

  const [rows, [totalRow]] = await Promise.all([
    executor
      .select(itemColumns)
      .from(collectionItems)
      .where(where)
      .orderBy(asc(collectionItems.position), asc(collectionItems.createdAt), asc(collectionItems.id))
      .limit(pagination.limit)
      .offset(toOffset(pagination)),
    executor.select({ value: count() }).from(collectionItems).where(where),
  ]);

  return {
    items: rows as ItemRow[],
    total: Number(totalRow?.value ?? 0),
  };
}

/**
 * How many items in each of these collections the viewer may see.
 *
 * One grouped query for a whole page of cards, not one per card. This is what
 * the DTO's `itemCount` is built from — deliberately NOT the stored
 * `collections.item_count`, which counts every row including the ones this
 * reader cannot see. Printing the stored number over a shorter list is the
 * exact defect that made a deleted comment's replies vanish: a header that
 * disagrees with the body underneath it.
 */
export async function countVisibleItemsFor(
  collectionIds: string[],
  viewer: Viewer,
  executor: Executor = db,
): Promise<Map<string, number>> {
  if (collectionIds.length === 0) return new Map();

  const rows = await executor
    .select({ collectionId: collectionItems.collectionId, value: count() })
    .from(collectionItems)
    .where(
      and(
        inArray(collectionItems.collectionId, collectionIds),
        isNull(collectionItems.deletedAt),
        collectionItemVisibleTo(viewer),
      ),
    )
    .groupBy(collectionItems.collectionId);

  return new Map(rows.map((r) => [r.collectionId, Number(r.value)]));
}

export async function findItemById(
  itemId: string,
  executor: Executor = db,
): Promise<ItemRow | null> {
  const rows = await executor
    .select(itemColumns)
    .from(collectionItems)
    .where(and(eq(collectionItems.id, itemId), isNull(collectionItems.deletedAt)))
    .limit(1);

  return (rows[0] as ItemRow) ?? null;
}

/** The soft-deleted item for this (collection, target) pair, if one exists. */
export async function findItemIncludingDeleted(
  collectionId: string,
  targetType: 'document' | 'post' | 'collection',
  targetId: string,
  executor: Executor = db,
): Promise<{ id: string; deletedAt: Date | null; position: number } | null> {
  const rows = await executor
    .select({
      id: collectionItems.id,
      deletedAt: collectionItems.deletedAt,
      position: collectionItems.position,
    })
    .from(collectionItems)
    .where(
      and(
        eq(collectionItems.collectionId, collectionId),
        eq(collectionItems.targetType, targetType),
        eq(collectionItems.targetId, targetId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function nextPosition(collectionId: string, executor: Executor = db): Promise<number> {
  const [row] = await executor
    .select({ value: sql<number>`coalesce(max(${collectionItems.position}), 0)::int` })
    .from(collectionItems)
    .where(and(eq(collectionItems.collectionId, collectionId), isNull(collectionItems.deletedAt)));

  return Number(row?.value ?? 0) + 1;
}

export async function insertItem(
  executor: Executor,
  values: {
    collectionId: string;
    targetType: 'document' | 'post' | 'collection';
    targetId: string;
    addedByUserId: string;
    note: string | null;
    position: number;
  },
): Promise<{ id: string }> {
  const [row] = await executor
    .insert(collectionItems)
    .values(values)
    .returning({ id: collectionItems.id });
  return { id: row!.id };
}

/**
 * Bring back an item that was removed from this collection before.
 *
 * Restore-on-re-add, matching likes, follows and bookmarks. The partial unique
 * is on `deleted_at IS NULL`, so without this a re-add would insert a second
 * row for the same target and the collection would show it twice.
 */
export async function restoreItem(
  executor: Executor,
  itemId: string,
  note: string | null,
  position: number,
): Promise<void> {
  await executor
    .update(collectionItems)
    .set({ deletedAt: null, note, position })
    .where(eq(collectionItems.id, itemId));
}

export async function softDeleteItem(executor: Executor, itemId: string): Promise<void> {
  await executor
    .update(collectionItems)
    .set({ deletedAt: new Date() })
    .where(eq(collectionItems.id, itemId));
}

/**
 * Rewrite `position` for a collection's items.
 *
 * The ids given are placed first, in the order given, and **everything else
 * follows** in the order it was already in. Renumbering the whole collection
 * rather than only the listed ids is what makes a partial payload
 * well-defined: a client sends the items it can see, and "these go to the
 * front" is a total order, whereas "assign these positions" is not — with the
 * old form, moving item B to the front while item A already sat at position 1
 * left both at 1 and the tiebreak silently decided the visible order.
 *
 * The `WHERE` carries the collection id, so a crafted body cannot reorder
 * somebody else's collection, and ids that are not in this collection are
 * simply ranked with the rest. A 404 is not raised for an id that was removed
 * between the client's read and its write, because that is a legitimate race
 * and the client's intent — "this first" — is still satisfiable.
 */
export async function applyOrder(
  executor: Executor,
  collectionId: string,
  orderedIds: string[],
): Promise<void> {
  // One statement with a VALUES join rather than N updates. A drag-to-reorder
  // of 200 items would otherwise be 200 round trips inside a transaction, which
  // holds row locks for the duration of a network conversation.
  const values = sql.join(
    orderedIds.map((id, index) => sql`(${id}::uuid, ${index + 1}::int)`),
    sql`, `,
  );

  const ranked = orderedIds.length === 0
    ? // No ids: a plain renumber into the existing order. Handled separately
    // because `VALUES` with zero rows is a syntax error.
    sql`
        SELECT ci.id,
               row_number() OVER (
                 ORDER BY ci.position, ci.created_at, ci.id
               )::int AS new_position
          FROM collection_items ci
         WHERE ci.collection_id = ${collectionId}
           AND ci.deleted_at IS NULL
      `
    : sql`
        SELECT ci.id,
               row_number() OVER (
                 ORDER BY (v.ord IS NULL), v.ord, ci.position, ci.created_at, ci.id
               )::int AS new_position
          FROM collection_items ci
          LEFT JOIN (VALUES ${values}) AS v(id, ord) ON v.id = ci.id
         WHERE ci.collection_id = ${collectionId}
           AND ci.deleted_at IS NULL
      `;

  await executor.execute(sql`
    UPDATE ${collectionItems} AS ci
       SET position = ranked.new_position
      FROM (${ranked}) AS ranked
     WHERE ci.id = ranked.id
  `);
}

// The hydrators that used to live here moved to `../shared/hydrate.js`. They
// were never collection-specific — they load a polymorphic target and apply
// its owning module's visibility rule — and bookmarks needs exactly the same
// three queries. A second copy would have been a second place for the document
// visibility rule to live, which is the one thing this module's header warns
// against.
