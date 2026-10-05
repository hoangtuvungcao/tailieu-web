import type { FastifyReply, FastifyRequest } from 'fastify';

import { getSearchProvider, SEARCHABLE_FIELDS } from '../../lib/search/index.js';
import { parseBody, parseQuery } from '../../lib/validation.js';
import { getUserModerationScope } from '../rbac/rbac.service.js';
import { reindexSchema, searchQuerySchema, suggestQuerySchema } from './search.schema.js';

/**
 * Search HTTP layer.
 *
 * The same deliberate property as the taxonomy and document reads: this file
 * knows nothing about how matching works. It converts a request into a
 * `SearchRequest`, hands it to whichever provider is configured, and serialises
 * the result. Swapping Postgres for Meilisearch changes no line here.
 */

async function viewerOf(request: FastifyRequest) {
  if (!request.user) {
    return { userId: null, isModerator: false, facultyIds: [] as string[] };
  }

  const scope = await getUserModerationScope(request.user.id);
  return {
    userId: request.user.id,
    isModerator: scope.global,
    facultyIds: scope.facultyIds,
  };
}

export async function search(request: FastifyRequest, reply: FastifyReply) {
  const query = parseQuery(searchQuerySchema, request.query);
  const provider = getSearchProvider();

  const result = await provider.search({
    query: query.q ?? '',
    filters: {
      facultyId: query.facultyId,
      programId: query.programId,
      subjectId: query.subjectId,
      courseId: query.courseId,
      academicYearId: query.academicYearId,
      semesterId: query.semesterId,
      documentTypeId: query.documentTypeId,
      fileKind: query.fileKind,
      tag: query.tag,
      ownerUserId: query.ownerUserId,
      publishedAfter: query.publishedAfter,
      publishedBefore: query.publishedBefore,
      minRating: query.minRating,
    },
    sort: query.sort,
    page: query.page,
    limit: query.limit,
    viewer: await viewerOf(request),
    includeRelations: false,
  });

  return reply.ok(result.hits, {
    page: result.page,
    limit: result.limit,
    total: result.total,
    totalPages: result.totalPages,
    tookMs: result.tookMs,
    provider: result.provider,
    // Echoed back so the UI can render "showing results for …" and build
    // shareable links without re-deriving what it sent.
    query: query.q ?? '',
    sort: query.sort,
  });
}

export async function suggest(request: FastifyRequest, reply: FastifyReply) {
  const query = parseQuery(suggestQuerySchema, request.query);
  const provider = getSearchProvider();
  const suggestions = await provider.suggest(query.q, query.limit);
  return reply.ok(suggestions);
}

/**
 * Describe the search surface: which fields are searched and which backends
 * are supported.
 *
 * The frontend reads this to build filter UI and to render an honest
 * "searching titles, tags and subjects" hint, rather than hard-coding a list
 * that drifts when the provider changes.
 */
export async function searchInfo(_request: FastifyRequest, reply: FastifyReply) {
  const provider = getSearchProvider();
  const health = await provider.health();

  return reply.ok({
    provider: provider.name,
    healthy: health.ok,
    fields: SEARCHABLE_FIELDS,
    sorts: ['relevance', 'newest', 'oldest', 'popular', 'rated', 'title'],
    supportedProviders: ['postgres', 'meilisearch', 'opensearch', 'elasticsearch'],
    limits: {
      maxPageSize: 100,
      maxQueryLength: 200,
      suggestLimit: 20,
    },
  });
}

/** Backend reachability, for the admin panel's system status. */
export async function searchHealth(_request: FastifyRequest, reply: FastifyReply) {
  const provider = getSearchProvider();
  const health = await provider.health();

  if (!health.ok) {
    return reply.status(503).send({
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Dịch vụ tìm kiếm hiện không khả dụng.',
      },
    });
  }

  return reply.ok({ provider: provider.name, status: 'ok', detail: health.detail ?? null });
}

/** Rebuild index state. A no-op for Postgres; meaningful for external engines. */
export async function reindex(request: FastifyRequest, reply: FastifyReply) {
  const body = parseBody(reindexSchema, request.body ?? {});
  const provider = getSearchProvider();

  const ids = body.documentIds;
  for (const id of ids) {
    await provider.indexDocument(id);
  }

  return reply.ok(
    { reindexed: ids.length, provider: provider.name },
    {},
    ids.length === 0
      ? 'Không có tài liệu nào cần đánh lại chỉ mục.'
      : `Đã đánh lại chỉ mục cho ${ids.length} tài liệu.`,
  );
}

