import type { FastifyReply, FastifyRequest } from 'fastify';

import { paginationMeta } from '../../../lib/pagination.js';
import { parseBody, parseParams, parseQuery } from '../../../lib/validation.js';
import { buildActor, requireActor } from '../shared/actor.js';
import * as service from './posts.service.js';
import {
  createPostSchema,
  listPostsQuerySchema,
  postIdParamSchema,
  updatePostSchema,
} from './posts.schema.js';

/**
 * Posts HTTP layer.
 *
 * Reads use `optionalAuth`: a public post must be readable by an anonymous
 * visitor, and `likedByViewer` is false for them rather than absent, so the
 * client has one shape to render.
 */

export async function listPosts(request: FastifyRequest, reply: FastifyReply) {
  const actor = await buildActor(request);
  const query = parseQuery(listPostsQuerySchema, request.query);
  const result = await service.listPosts(query, query, actor);
  return reply.ok(result.items, paginationMeta(result));
}

export async function getPost(request: FastifyRequest, reply: FastifyReply) {
  const actor = await buildActor(request);
  const { id } = parseParams(postIdParamSchema, request.params);
  return reply.ok(await service.getPost(id, actor));
}

export async function createPost(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const body = parseBody(createPostSchema, request.body);

  const post = await service.createPost(body, actor);
  reply.status(201);
  return reply.ok(post, {}, 'Đã đăng bài.');
}

export async function updatePost(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const { id } = parseParams(postIdParamSchema, request.params);
  const body = parseBody(updatePostSchema, request.body);

  return reply.ok(await service.updatePost(id, body, actor), {}, 'Đã cập nhật bài đăng.');
}

export async function deletePost(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const { id } = parseParams(postIdParamSchema, request.params);

  await service.deletePost(id, actor);
  return reply.ok({ deleted: true }, {}, 'Đã xoá bài đăng.');
}
