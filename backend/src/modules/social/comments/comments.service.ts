import { db } from '../../../db/client.js';
import { AppError } from '../../../lib/errors.js';
import { paginate, type PaginationInput } from '../../../lib/pagination.js';
import { adjustCounter, refreshPostHotScore } from '../shared/counters.js';
import { isoDateTime as iso } from '../shared/dates.js';
import { recordTrendSignal, TREND_WEIGHTS } from '../feed/trending.js';
import { notify } from '../notifications/notifications.service.js';
import type { SocialActor } from '../shared/actor.js';
import { documentVisibilityPredicate, postVisibilityPredicate } from '../shared/visibility.js';
import { documents, posts } from '../../../db/schema/index.js';
import { and, eq } from 'drizzle-orm';
import * as repo from './comments.repository.js';
import type { createCommentSchema } from './comments.schema.js';
import type { z } from 'zod';

/**
 * Comment service.
 *
 * Two things here are easy to get wrong and both are handled explicitly:
 *
 *   1. THE TARGET MUST BE VISIBLE. A comment is not a container — it is
 *      attached to something, and if the viewer cannot read the document or
 *      post it hangs off, they must not read the comment either. Resolving this
 *      once, up front, is what makes every downstream query safe.
 *
 *   2. THE COUNTER GOES TO TWO PLACES. A reply increments its parent's
 *      `reply_count` AND the target's `comment_count`. Missing either leaves a
 *      number that is quietly wrong forever, which is why both go through the
 *      same `adjustCounter`.
 */

const MAX_DEPTH = 3;

export interface CommentDto {
  id: string;
  body: string;
  depth: number;
  parentCommentId: string | null;
  author: { id: string; displayName: string; avatarUrl: string | null };
  stats: { likes: number; replies: number };
  likedByViewer: boolean;
  /**
   * True when the comment was removed — by its author or by a moderator.
   *
   * The row still holds the thread together (see `listThread`), but it carries
   * no content, no author and no actions. The client renders a placeholder so
   * the replies underneath keep their context.
   */
  deleted: boolean;
  createdAt: string;
  editedAt: string | null;
  permissions: { canEdit: boolean; canDelete: boolean };
  /** Populated only on top-level comments. */
  replies?: CommentDto[];
}

/**
 * The single point where a comment body is allowed to become a response.
 *
 * A tombstone is stripped here and nowhere else, which is what makes the
 * repository safe to query without a `deleted_at IS NULL` filter: the rows come
 * back, but the words do not leave. If this function ever returns `row.body`
 * for a removed row, a moderator's takedown becomes readable again.
 */
function toDto(row: repo.CommentRow, actor: SocialActor | null, liked: boolean): CommentDto {
  const isAuthor = actor?.userId === row.authorUserId;
  const isModerator = actor?.permissions.has('comments.moderate') ?? false;
  const deleted = repo.isTombstone(row);

  if (deleted) {
    return {
      id: row.id,
      body: '',
      depth: row.depth,
      parentCommentId: row.parentCommentId,
      // The author is withheld too. Naming whoever wrote a removed comment
      // turns a takedown into a public record of who was moderated.
      author: { id: '', displayName: 'Người dùng', avatarUrl: null },
      // A removed comment's reaction counts describe content nobody can read.
      stats: { likes: 0, replies: row.replyCount },
      likedByViewer: false,
      deleted: true,
      createdAt: iso(row.createdAt),
      editedAt: null,
      permissions: { canEdit: false, canDelete: false },
    };
  }

  return {
    id: row.id,
    body: row.body,
    depth: row.depth,
    parentCommentId: row.parentCommentId,
    author: {
      id: row.authorUserId,
      displayName: row.authorName ?? 'Người dùng ẩn danh',
      avatarUrl: row.authorAvatar,
    },
    stats: { likes: row.likeCount, replies: row.replyCount },
    likedByViewer: liked,
    deleted: false,
    createdAt: iso(row.createdAt),
    editedAt: row.editedAt === null ? null : iso(row.editedAt),
    permissions: {
      // Editing is the author's alone. A moderator can hide a comment but must
      // not be able to put different words in somebody's mouth.
      canEdit: isAuthor,
      canDelete: isAuthor || isModerator,
    },
  };
}

/**
 * Confirm the viewer may see the thing being commented on, and find its owner.
 *
 * Runs the *same* predicate the owning module uses, so a comment can never be
 * readable where its target is not — which is the whole risk with comments
 * being polymorphic.
 *
 * The owner comes back from the same query rather than a second lookup. Every
 * extra query here is another place the visibility predicate could be
 * forgotten, and a notification addressed from a row fetched without one would
 * be a way to learn that a private document exists.
 */
async function resolveTarget(
  targetType: 'document' | 'post',
  targetId: string,
  actor: SocialActor | null,
): Promise<{ ownerUserId: string }> {
  const viewer = actor?.viewer ?? { userId: null, isModerator: false, facultyIds: [] };

  if (targetType === 'document') {
    const [row] = await db
      .select({ ownerUserId: documents.ownerUserId })
      .from(documents)
      .where(and(eq(documents.id, targetId), documentVisibilityPredicate(viewer)))
      .limit(1);

    if (!row) throw new AppError('DOCUMENT_NOT_FOUND', 'Không tìm thấy tài liệu.');
    return { ownerUserId: row.ownerUserId };
  }

  const [row] = await db
    .select({ ownerUserId: posts.authorUserId })
    .from(posts)
    .where(and(eq(posts.id, targetId), postVisibilityPredicate(viewer)))
    .limit(1);

  if (!row) throw new AppError('NOT_FOUND', 'Không tìm thấy bài đăng.');
  return { ownerUserId: row.ownerUserId };
}

export async function listComments(
  targetType: 'document' | 'post',
  targetId: string,
  pagination: PaginationInput,
  actor: SocialActor | null,
) {
  await resolveTarget(targetType, targetId, actor);

  const { items, total } = await repo.listThread(targetType, targetId, pagination);

  const [likedIds] = await Promise.all([
    repo.findLikedCommentIds(items.map((c) => c.id), actor?.userId ?? null),
  ]);

  // Rebuild the tree from the flat page.
  //
  // The rows arrive ordered by `(root, created_at)`, and a child is always
  // written after its parent — you cannot reply to a comment that does not
  // exist yet — so one pass is enough: by the time a row is placed, its parent
  // is already in the map.
  //
  // Nesting rather than flattening every descendant onto the root. A flat list
  // loses the shape of the conversation: a reply to a reply would render as a
  // sibling of the comment it answers, and `CommentDto.replies` — which is
  // recursive — would be dead on every row below the first level.
  const byId = new Map<string, CommentDto>();
  const roots: CommentDto[] = [];

  for (const row of items) {
    const dto = toDto(row, actor, likedIds.has(row.id));
    dto.replies = [];
    byId.set(row.id, dto);
    if (row.parentCommentId === null) roots.push(dto);
  }

  for (const row of items) {
    if (row.parentCommentId === null) continue;

    const dto = byId.get(row.id)!;
    // Attach to the real parent. The fallback to the thread root matters: if a
    // parent is ever missing from the page — truncated by the row limit, say —
    // the reply still lands somewhere visible instead of being dropped. Silent
    // dropping is precisely the failure this thread model exists to avoid.
    const parent = byId.get(row.parentCommentId) ?? (row.rootCommentId ? byId.get(row.rootCommentId) : undefined);
    if (parent) parent.replies!.push(dto);
  }

  return paginate(roots, total, pagination);
}

export async function createComment(
  input: z.infer<typeof createCommentSchema>,
  actor: SocialActor,
): Promise<CommentDto> {
  const target = await resolveTarget(input.targetType, input.targetId, actor);

  const created = await db.transaction(async (tx) => {
    let depth = 0;
    let rootCommentId: string | null = null;
    /** Set when this is a reply: who to tell, and which comment they wrote. */
    let replyTo: { userId: string; commentId: string } | null = null;

    if (input.parentCommentId) {
      const parent = await repo.findCommentById(input.parentCommentId, tx);

      if (!parent) {
        throw new AppError('NOT_FOUND', 'Không tìm thấy bình luận được trả lời.');
      }
      // A reply must be to a comment on the same thing, or the thread becomes
      // a way to attach text to an unrelated document.
      if (parent.targetId !== input.targetId) {
        throw new AppError('BAD_REQUEST', 'Bình luận được trả lời thuộc nội dung khác.');
      }
      if (parent.depth >= MAX_DEPTH) {
        throw new AppError(
          'BAD_REQUEST',
          `Chỉ trả lời được tối đa ${MAX_DEPTH} cấp.`,
        );
      }

      depth = parent.depth + 1;
      rootCommentId = parent.rootCommentId ?? parent.id;
      replyTo = { userId: parent.authorUserId, commentId: parent.id };
    }

    const { id } = await repo.insertComment(tx, {
      targetType: input.targetType,
      targetId: input.targetId,
      authorUserId: actor.userId,
      parentCommentId: input.parentCommentId,
      rootCommentId,
      depth,
      body: input.body,
    });

    // A top-level comment is its own root. Done as a second statement because
    // the id does not exist until the row does.
    if (rootCommentId === null) {
      await repo.setRoot(tx, id);
    }

    // --- Two counters, one code path ---------------------------------------
    if (input.parentCommentId) {
      await adjustCounter(tx, { table: 'comments', column: 'reply_count' }, input.parentCommentId, 1);
    }

    if (input.targetType === 'document') {
      await adjustCounter(tx, { table: 'documents', column: 'comment_count' }, input.targetId, 1);
    } else {
      await adjustCounter(tx, { table: 'posts', column: 'comment_count' }, input.targetId, 1);
      // The hot score is derived from the counters, so it is recomputed here
      // rather than incremented — a derived value that is incremented on every
      // event is permanently wrong after one missed event.
      await refreshPostHotScore(tx, input.targetId);
    }

    // --- Notify -------------------------------------------------------------
    // A reply tells the person replied to; a top-level comment tells whoever
    // owns the thing commented on. Never both — the author of a post does not
    // also need a second notification for a reply buried in their own thread,
    // which is the same fact told twice.
    //
    // Inside the transaction, so a notification cannot outlive a comment that
    // was rolled back. `notify` returns early when the actor is the recipient,
    // so commenting on your own content is silent without a check here.
    //
    // NOT retracted when the comment is later deleted: unlike a follow, which
    // is undone, a deleted comment leaves a tombstone that still holds its
    // place in the thread — so "A replied to you" remains true.
    const kind = replyTo
      ? 'comment_reply'
      : input.targetType === 'document'
        ? 'document_comment'
        : 'post_comment';

    await notify(tx, {
      recipientUserId: replyTo ? replyTo.userId : target.ownerUserId,
      actorUserId: actor.userId,
      kind,
      // Points at the THREAD, not at the comment. A comment has no page of its
      // own, so a notification targeting one would be a link to nowhere —
      // whichever kind this is, the recipient has to land somewhere they can
      // read the thing. `kind` is what distinguishes a reply from a top-level
      // comment, so nothing is lost by not targeting the comment.
      targetType: input.targetType,
      targetId: input.targetId,
      // Collapses repeats per *thing commented on*: a hundred replies to one
      // comment become one row reading "A và 99 người khác". The key names the
      // comment rather than the thread, so two busy threads on the same post
      // stay two notifications rather than merging into one meaningless count.
      groupKey: `${kind}:${replyTo ? replyTo.commentId : input.targetId}`,
      payload: {},
    });

    return { id };
  });

  // After the commit, and only for posts. Comments on documents are not part of
  // any ranked list, and recording them would put document ids into a set that
  // is only ever read against posts.
  if (input.targetType === 'post') {
    await recordTrendSignal(input.targetId, TREND_WEIGHTS.comment);
  }

  const row = await repo.findCommentById(created.id);
  if (!row) throw new Error('Comment vanished immediately after creation.');

  return toDto(row, actor, false);
}

export async function updateComment(
  id: string,
  body: string,
  actor: SocialActor,
): Promise<CommentDto> {
  const existing = await repo.findCommentById(id);
  if (!existing) throw new AppError('NOT_FOUND', 'Không tìm thấy bình luận.');

  if (existing.authorUserId !== actor.userId) {
    throw new AppError('FORBIDDEN', 'Bạn không có quyền sửa bình luận này.');
  }

  // The target's visibility is re-checked here too: an author who has since
  // lost access to the document must not be able to keep editing their comment
  // on it.
  await resolveTarget(existing.targetType, existing.targetId, actor);

  await repo.updateComment(db, id, body);

  const updated = await repo.findCommentById(id);
  return toDto(updated!, actor, false);
}

export async function deleteComment(id: string, actor: SocialActor): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await repo.findCommentById(id, tx);
    if (!existing) throw new AppError('NOT_FOUND', 'Không tìm thấy bình luận.');

    const isAuthor = existing.authorUserId === actor.userId;
    const isModerator =
      (actor.permissions.has('comments.moderate') || actor.permissions.has('superadmin.all')) &&
      (actor.viewer.isModerator || actor.viewer.facultyIds.length > 0 || isAuthor);

    if (!isAuthor && !isModerator) {
      throw new AppError('FORBIDDEN', 'Bạn không có quyền xoá bình luận này.');
    }

    // Soft delete. The reply count is decremented on the parent — and NOT on the
    // target's comment count, deliberately: a removed comment leaves a visible
    // gap in the thread, and decrementing would make the count disagree with
    // what the reader can see.
    await repo.softDeleteComment(tx, id);

    if (existing.parentCommentId) {
      await adjustCounter(tx, { table: 'comments', column: 'reply_count' }, existing.parentCommentId, -1);
    }
  });
}
