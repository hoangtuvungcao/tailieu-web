import type { FastifyRequest, FastifyReply } from 'fastify';

import { paginationMeta } from '../../../lib/pagination.js';
import { parseBody, parseParams, parseQuery } from '../../../lib/validation.js';
import { buildActor, requireActor } from '../shared/actor.js';
import * as service from './collections.service.js';
import {
  addItemSchema,
  collectionIdParamSchema,
  createCollectionSchema,
  itemParamsSchema,
  listCollectionsQuerySchema,
  listItemsQuerySchema,
  reorderItemsSchema,
  updateCollectionSchema,
} from './collections.schema.js';

/**
 * Collections HTTP layer.
 *
 * Reads are `optionalAuth` and the service decides — a public collection is
 * browsable by a visitor, and the item list is filtered per viewer either way.
 *
 * Writes are `authenticate` plus a permission where one is meaningful.
 * `canEdit`/`canDelete` on the DTO are for the client to hide controls it would
 * be refused anyway; every route re-checks, because a permission the frontend
 * reports is a hint and never a gate.
 */

export async function listCollections(request: FastifyRequest, reply: FastifyReply) {
  const actor = await buildActor(request);
  const query = parseQuery(listCollectionsQuerySchema, request.query);
  const result = await service.listCollections(query, query, actor);
  return reply.ok(result.items, paginationMeta(result));
}

export async function listMine(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const query = parseQuery(listItemsQuerySchema, request.query);
  const result = await service.listOwnCollections(query, actor);
  return reply.ok(result.items, paginationMeta(result));
}

export async function getCollection(request: FastifyRequest, reply: FastifyReply) {
  const actor = await buildActor(request);
  const { id } = parseParams(collectionIdParamSchema, request.params);
  const query = parseQuery(listItemsQuerySchema, request.query);

  const { collection, items } = await service.getCollection(id, query, actor);
  return reply.ok(collection, items);
}

export async function createCollection(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const body = parseBody(createCollectionSchema, request.body);

  const collection = await service.createCollection(body, actor);
  reply.status(201);
  return reply.ok(collection, {}, 'Đã tạo bộ sưu tập.');
}

export async function updateCollection(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const { id } = parseParams(collectionIdParamSchema, request.params);
  const body = parseBody(updateCollectionSchema, request.body);

  return reply.ok(await service.updateCollection(id, body, actor), {}, 'Đã cập nhật bộ sưu tập.');
}

export async function deleteCollection(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const { id } = parseParams(collectionIdParamSchema, request.params);

  await service.deleteCollection(id, actor);
  return reply.ok({ deleted: true }, {}, 'Đã xoá bộ sưu tập.');
}

export async function addItem(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const { id } = parseParams(collectionIdParamSchema, request.params);
  const body = parseBody(addItemSchema, request.body);

  const item = await service.addItem(id, body, actor);
  reply.status(201);
  return reply.ok(item, {}, 'Đã thêm vào bộ sưu tập.');
}

export async function removeItem(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const params = parseParams(itemParamsSchema, request.params);

  await service.removeItem(params.id, params.itemId, actor);
  return reply.ok({ removed: true }, {}, 'Đã xoá khỏi bộ sưu tập.');
}

export async function reorderItems(request: FastifyRequest, reply: FastifyReply) {
  const actor = await requireActor(request);
  const { id } = parseParams(collectionIdParamSchema, request.params);
  const body = parseBody(reorderItemsSchema, request.body);

  await service.reorderItems(id, body.itemIds, actor);
  return reply.ok({ reordered: true }, {}, 'Đã sắp xếp lại.');
}
