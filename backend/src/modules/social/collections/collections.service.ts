import { db } from '../../../db/client.js';
import { AppError } from '../../../lib/errors.js';
import { paginate, paginationMeta, type PaginationInput } from '../../../lib/pagination.js';
import { adjustCounter } from '../shared/counters.js';
import { assertTargetVisibleTo } from '../shared/targets.js';
import type { SocialActor } from '../shared/actor.js';
import type { Viewer } from '../shared/visibility.js';
import * as repo from './collections.repository.js';
import type { addItemSchema, createCollectionSchema, updateCollectionSchema } from './collections.schema.js';
import type { z } from 'zod';

/**
 * Collection service.
 *
 * A collection is a curated, ordered, *shareable* list of pointers. Everything
 * hard about it follows from "shareable": the collection's own visibility says
 * nothing about whether the things inside it may be seen by whoever is looking,
 * so the item list is filtered by the viewer at read time, every time.
 *
 * The other half is the count. `collections.item_count` is maintained and is
 * the true number of rows — but it is never what a reader is shown. A public
 * collection holding two private documents would otherwise announce twelve
 * items above a list of ten.
 */

export interface CollectionItemTargetDto {
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

export interface CollectionItemDto {
  id: string;
  note: string | null;
  position: number;
  addedAt: string;
  target: CollectionItemTargetDto;
}

export interface CollectionDto {
  id: string;
  title: string;
  description: string | null;
  visibility: string;
  coverDocumentId: string | null;
  owner: { id: string; displayName: string; avatarUrl: string | null };
  /**
   * Items *this viewer* can see — not the stored `item_count`.
   *
   * Two numbers exist and only one of them is honest to print here: the stored
   * counter is the true row count, and exposing it would put a headline above a
   * shorter list whenever a collection holds something the reader cannot open.
   */
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  permissions: { canEdit: boolean; canDelete: boolean; canAddItem: boolean };
  /** Present on the detail response only. */
  items?: CollectionItemDto[];
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function canModerateCollections(actor: SocialActor | null): boolean {
  return (
    (actor?.permissions.has('collections.moderate') ?? false) ||
    (actor?.permissions.has('superadmin.all') ?? false)
  );
}

function toCollectionDto(
  row: repo.CollectionRow,
  visibleItemCount: number,
  actor: SocialActor | null,
  permissions: { canEdit: boolean; canDelete: boolean; canAddItem: boolean },
): CollectionDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    coverDocumentId: row.coverDocumentId,
    owner: {
      id: row.ownerUserId,
      displayName: row.ownerName ?? 'Người dùng ẩn danh',
      avatarUrl: row.ownerAvatar,
    },
    itemCount: visibleItemCount,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    permissions,
  };
}

/**
 * Who may do what to a collection.
 *
 * The owner may do everything. A moderator may take a collection down and may
 * remove one item from it, but may **not** add items or edit its title: curating
 * somebody else's list is not moderation, and an edit performed under a
 * moderation power is indistinguishable afterwards from the owner's own.
 */
function permissionsFor(actor: SocialActor | null, row: repo.CollectionRow) {
  const isOwner = actor?.userId === row.ownerUserId;
  const isModerator = canModerateCollections(actor);

  return {
    canEdit: isOwner,
    canDelete: isOwner || isModerator,
    canAddItem: isOwner,
  };
}

/**
 * Load the pointed-at rows for a page of items and pair them up.
 *
 * Three queries for the whole page, one per target kind, never one per item.
 *
 * An item whose target does not come back is dropped and logged. It should be
 * impossible — `listItems` applied the same predicate — so a drop means the two
 * disagree, and that is a bug worth a log line rather than a shorter list
 * nobody notices.
 */
async function hydrateItems(
  items: repo.ItemRow[],
  viewer: Viewer,
): Promise<CollectionItemDto[]> {
  const idsBy = { document: [] as string[], post: [] as string[], collection: [] as string[] };
  for (const item of items) idsBy[item.targetType].push(item.targetId);

  const [documents, posts, nested] = await Promise.all([
    repo.hydrateDocuments(idsBy.document, viewer),
    repo.hydratePosts(idsBy.post, viewer),
    repo.hydrateCollections(idsBy.collection, viewer),
  ]);

  const hydrated: CollectionItemDto[] = [];
  const missing: string[] = [];

  for (const item of items) {
    let target: CollectionItemTargetDto | null = null;

    if (item.targetType === 'document') {
      const row = documents.get(item.targetId);
      if (row) {
        target = {
          type: 'document',
          id: row.id,
          title: row.title,
          owner: { id: row.ownerId, displayName: row.ownerName ?? 'Người dùng ẩn danh', avatarUrl: row.ownerAvatar },
          visibility: row.visibility,
          fileKind: row.fileKind,
          sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
          stats: { likes: 0, comments: 0, items: 0 },
        };
      }
    } else if (item.targetType === 'post') {
      const row = posts.get(item.targetId);
      if (row) {
        target = {
          type: 'post',
          id: row.id,
          // A status post has no title. Falling back to its opening words keeps
          // every card in the list the same shape instead of rendering a blank
          // line where a title should be.
          title: row.title ?? row.body.slice(0, 80),
          owner: { id: row.authorId, displayName: row.authorName ?? 'Người dùng ẩn danh', avatarUrl: row.authorAvatar },
          visibility: row.visibility,
          fileKind: null,
          sizeBytes: null,
          stats: { likes: row.likeCount, comments: row.commentCount, items: 0 },
        };
      }
    } else {
      const row = nested.get(item.targetId);
      if (row) {
        target = {
          type: 'collection',
          id: row.id,
          title: row.title,
          owner: { id: row.ownerId, displayName: row.ownerName ?? 'Người dùng ẩn danh', avatarUrl: row.ownerAvatar },
          visibility: row.visibility,
          fileKind: null,
          sizeBytes: null,
          // This one number is the stored counter, not a viewer-visible count.
          // Computing it per nested collection would mean a count query inside
          // the hydration of a page of items, and the nested card is a link —
          // the number is a hint of size, not a promise about the next page.
          stats: { likes: 0, comments: 0, items: row.itemCount },
        };
      }
    }

    if (!target) {
      missing.push(item.id);
      continue;
    }

    hydrated.push({
      id: item.id,
      note: item.note,
      position: item.position,
      addedAt: iso(item.createdAt),
      target,
    });
  }

  if (missing.length > 0) {
    // Never silent. A drop here means the item predicate and the owning
    // module's predicate disagree about the same row, which is a visibility bug
    // — and the safe direction (fewer items) is also the invisible one, so it
    // would otherwise go unreported for as long as nobody counted.
    console.warn(
      `[collections] ${missing.length} item(s) passed the item predicate but were filtered out during hydration: ${missing.join(', ')}`,
    );
  }

  return hydrated;
}

/**
 * The item count for a page of collections, viewer-relative.
 *
 * One grouped query, falling back to the stored counter only where the grouped
 * query returned no row — which happens for an empty collection and means zero,
 * so the fallback is `0` rather than the stored value.
 */
async function visibleCounts(
  ids: string[],
  viewer: Viewer,
): Promise<Map<string, number>> {
  return repo.countVisibleItemsFor(ids, viewer);
}

// =============================================================================
// Reads
// =============================================================================

export async function listCollections(
  filters: { ownerUserId?: string; q?: string },
  pagination: PaginationInput,
  actor: SocialActor | null,
) {
  const viewer = actor?.viewer ?? { userId: null, isModerator: false, facultyIds: [] };
  const { items, total } = await repo.listCollections(filters, pagination, viewer);

  const counts = await visibleCounts(items.map((c) => c.id), viewer);

  return paginate(
    items.map((row) =>
      toCollectionDto(row, counts.get(row.id) ?? 0, actor, permissionsFor(actor, row)),
    ),
    total,
    pagination,
  );
}

export async function listOwnCollections(pagination: PaginationInput, actor: SocialActor) {
  const { items, total } = await repo.listOwnCollections(actor.userId, pagination);
  const counts = await visibleCounts(items.map((c) => c.id), actor.viewer);

  return paginate(
    items.map((row) =>
      toCollectionDto(row, counts.get(row.id) ?? 0, actor, permissionsFor(actor, row)),
    ),
    total,
    pagination,
  );
}

export async function getCollection(
  id: string,
  pagination: PaginationInput,
  actor: SocialActor | null,
) {
  const viewer = actor?.viewer ?? { userId: null, isModerator: false, facultyIds: [] };

  const row = await repo.findCollectionById(id, viewer);
  // 404, not 403. A private collection the caller cannot see must be
  // indistinguishable from one that does not exist, or the id itself becomes
  // the leak.
  if (!row) throw new AppError('NOT_FOUND', 'Không tìm thấy bộ sưu tập.');

  const { items, total } = await repo.listItems(id, viewer, pagination);
  const hydrated = await hydrateItems(items, viewer);

  const dto = toCollectionDto(row, total, actor, permissionsFor(actor, row));
  dto.items = hydrated;

  // `itemCount` above and `total` here are the same number from the same
  // filtered query, so the headline cannot disagree with the list under it.
  return { collection: dto, items: paginationMeta(paginate(hydrated, total, pagination)) };
}

// =============================================================================
// Writes
// =============================================================================

export async function createCollection(
  input: z.infer<typeof createCollectionSchema>,
  actor: SocialActor,
): Promise<CollectionDto> {
  // Checked before the insert so the failure is a readable 409 rather than the
  // raw unique-violation the index would raise.
  const clash = await repo.findOwnedByTitle(actor.userId, input.title);
  if (clash) {
    throw new AppError('CONFLICT', `Bạn đã có bộ sưu tập tên "${input.title}".`);
  }

  const { id } = await repo.insertCollection(db, {
    ownerUserId: actor.userId,
    title: input.title,
    description: input.description,
    visibility: input.visibility,
  });

  const row = await repo.findCollectionUnscoped(id);
  return toCollectionDto(row!, 0, actor, { canEdit: true, canDelete: true, canAddItem: true });
}

/**
 * Fetch a collection and confirm the actor may edit it.
 *
 * The 404-for-not-yours shape is deliberate and mirrors every other write path
 * in the project: answering 403 for a collection that exists and 404 for one
 * that does not tells the caller which ids are real.
 */
async function requireOwnedCollection(id: string, actor: SocialActor): Promise<repo.CollectionRow> {
  const row = await repo.findCollectionUnscoped(id);
  if (!row || row.ownerUserId !== actor.userId) {
    throw new AppError('NOT_FOUND', 'Không tìm thấy bộ sưu tập.');
  }
  return row;
}

export async function updateCollection(
  id: string,
  patch: z.infer<typeof updateCollectionSchema>,
  actor: SocialActor,
): Promise<CollectionDto> {
  await requireOwnedCollection(id, actor);

  if (patch.title !== undefined) {
    const clash = await repo.findOwnedByTitle(actor.userId, patch.title, db, id);
    if (clash) {
      throw new AppError('CONFLICT', `Bạn đã có bộ sưu tập tên "${patch.title}".`);
    }
  }

  // The cover is a document id, so it has to be one the owner can actually
  // open. Without this check a user could set a stranger's private document as
  // their cover and the id would be echoed back in every response.
  if (patch.coverDocumentId) {
    await assertTargetVisibleTo('document', patch.coverDocumentId, actor.viewer);
  }

  await repo.updateCollection(db, id, patch);

  const row = await repo.findCollectionUnscoped(id);
  const counts = await visibleCounts([id], actor.viewer);
  return toCollectionDto(row!, counts.get(id) ?? 0, actor, permissionsFor(actor, row!));
}

export async function deleteCollection(id: string, actor: SocialActor): Promise<void> {
  const row = await repo.findCollectionUnscoped(id);
  if (!row) throw new AppError('NOT_FOUND', 'Không tìm thấy bộ sưu tập.');

  const isOwner = row.ownerUserId === actor.userId;
  if (!isOwner && !canModerateCollections(actor)) {
    throw new AppError('NOT_FOUND', 'Không tìm thấy bộ sưu tập.');
  }

  // Soft delete. The items stay attached: a deleted collection is restored by
  // clearing one timestamp, and hard-deleting the rows would make that a
  // reconstruction rather than an undo.
  await repo.softDeleteCollection(db, id);
}

export async function addItem(
  collectionId: string,
  input: z.infer<typeof addItemSchema>,
  actor: SocialActor,
): Promise<CollectionItemDto> {
  await requireOwnedCollection(collectionId, actor);

  // You cannot file away what you cannot open. This is also what stops a public
  // collection being used to launder access to a private document: at the
  // moment of adding, the adder must already be able to see it.
  await assertTargetVisibleTo(input.targetType, input.targetId, actor.viewer);

  // The item row and the counter move in ONE transaction. A counter updated
  // after the commit can be lost by a crash between the two, and one updated
  // before it can survive a rolled-back insert — both leave a number that is
  // wrong forever. Returning the flag out of the transaction and adjusting
  // afterwards would be exactly the first of those two mistakes.
  const itemId = await db.transaction(async (tx) => {
    const existing = await repo.findItemIncludingDeleted(
      collectionId,
      input.targetType,
      input.targetId,
      tx,
    );

    if (existing && existing.deletedAt === null) {
      // Already in the collection. The note is still worth updating, but the
      // count must not move — otherwise the header starts disagreeing with the
      // list for the rest of the collection's life.
      await repo.restoreItem(tx, existing.id, input.note, existing.position);
      return existing.id;
    }

    const position = await repo.nextPosition(collectionId, tx);

    if (existing) {
      // Re-adding something previously removed keeps the same row. The partial
      // unique is on `deleted_at IS NULL`, so inserting instead would create a
      // second row for the same target and the collection would list it twice.
      await repo.restoreItem(tx, existing.id, input.note, position);
      await adjustCounter(tx, { table: 'collections', column: 'item_count' }, collectionId, 1);
      return existing.id;
    }

    const created = await repo.insertItem(tx, {
      collectionId,
      targetType: input.targetType,
      targetId: input.targetId,
      addedByUserId: actor.userId,
      note: input.note,
      position,
    });
    await adjustCounter(tx, { table: 'collections', column: 'item_count' }, collectionId, 1);
    return created.id;
  });

  const row = await repo.findItemById(itemId);
  const [dto] = await hydrateItems([row!], actor.viewer);
  if (!dto) throw new AppError('NOT_FOUND', 'Không tìm thấy nội dung để thêm.');
  return dto;
}

export async function removeItem(
  collectionId: string,
  itemId: string,
  actor: SocialActor,
): Promise<void> {
  const collection = await repo.findCollectionUnscoped(collectionId);
  if (!collection) throw new AppError('NOT_FOUND', 'Không tìm thấy bộ sưu tập.');

  const isOwner = collection.ownerUserId === actor.userId;
  // A moderator may pull a single item out of a collection without deleting the
  // collection — taking down one infringing document should not destroy the
  // curator's other ninety-nine entries.
  if (!isOwner && !canModerateCollections(actor)) {
    throw new AppError('NOT_FOUND', 'Không tìm thấy bộ sưu tập.');
  }

  const item = await repo.findItemById(itemId);
  // The item must belong to *this* collection. Without this check a moderator
  // could pass any item id alongside any collection id they own.
  if (!item || item.collectionId !== collectionId) {
    throw new AppError('NOT_FOUND', 'Không tìm thấy mục này trong bộ sưu tập.');
  }

  await db.transaction(async (tx) => {
    await repo.softDeleteItem(tx, itemId);
    await adjustCounter(tx, { table: 'collections', column: 'item_count' }, collectionId, -1);
  });
}

export async function reorderItems(
  collectionId: string,
  itemIds: string[],
  actor: SocialActor,
): Promise<void> {
  await requireOwnedCollection(collectionId, actor);

  // Ids that are not in this collection are ignored by the statement's WHERE.
  // Rejecting the whole request instead would fail a legitimate drag whenever
  // the client's page was stale — it sees a page of items, not all of them.
  await repo.applyOrder(db, collectionId, itemIds);
}
