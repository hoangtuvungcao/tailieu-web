import type { FastifyReply, FastifyRequest } from 'fastify';

import { paginationMeta } from '../../../lib/pagination.js';
import { parseBody, parseParams, parseQuery } from '../../../lib/validation.js';
import { buildActor, requireActor } from '../shared/actor.js';
import * as service from './comments.service.js';
import {
  commentIdParamSchema,
  createCommentSchema,
  listCommentsQuerySchema,
  updateCommentSchema,
} from './comments.schema.js';

/**
 * Comments HTTP layer.
 *
 * Note there is no `GET /comments` for a bare list — a comment is only
 * meaningful attached to something, so listing is always scoped by
 * `targetType` + `targetId`. A route that could list comments across targets
 * would be the easiest way to read comments on content you cannot see.
 */

export async function listComments(request: FastifyRequest, reply: FastifyReply) {
  const actor = await buildActor(request);
  const query = parseQuery(listCommentsQuerySchema, request.query);

  const result = await service.listComments(query.targetType, query.targetId, query, actor);
  return reply.ok(result.items, paginationMeta(result));
}

export async function createComment(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const body = parseBody(createCommentSchema, request.body);

  const comment = await service.createComment(body, actor);
  reply.status(201);
  return reply.ok(comment, {}, 'Đã gửi bình luận.');
}

export async function updateComment(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const { id } = parseParams(commentIdParamSchema, request.params);
  const body = parseBody(updateCommentSchema, request.body);

  return reply.ok(await service.updateComment(id, body.body, actor), {}, 'Đã sửa bình luận.');
}

export async function deleteComment(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const { id } = parseParams(commentIdParamSchema, request.params);

  await service.deleteComment(id, actor);
  return reply.ok({ deleted: true }, {}, 'Đã xoá bình luận.');
}
