import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { paginate, paginationMeta, paginationSchema } from '../../lib/pagination.js';
import { parseBody, parseQuery, uuidSchema } from '../../lib/validation.js';
import { requireActor } from '../social/shared/actor.js';
import * as service from './reports.service.js';
import { createReportBody, reportTargetSchema } from './reports.schema.js';

/**
 * Reports.
 *
 * Three endpoints, and the split is about who is asking:
 *
 *   POST /reports          a user filing an allegation
 *   GET  /reports/mine     a user reading back their own history
 *   GET  /reports/state    a page asking "have I already flagged this?"
 *
 * The reading side for moderators is NOT here. It lives under `/admin/reports`,
 * behind `reports.read`, because the queue is a different audience with a
 * different permission — putting both on one prefix would mean one route file
 * guarding half its handlers and not the other half.
 */

const stateQuery = z.object({
  targetType: reportTargetSchema,
  targetId: uuidSchema,
});

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/',
    {
      preHandler: [app.authenticate],
      config: {
        rateLimit: {
          /**
           * Tight, and much tighter than liking.
           *
           * A like is a signal a reader gives constantly; a report is an
           * accusation, and the abuse it invites is a script filing hundreds of
           * them. Twenty an hour is far above what a genuine reader needs — even
           * an energetic moderator-by-nature — while making a flood cost the
           * flooder a full hour.
           *
           * This is a second line. The first is the partial unique index, which
           * already makes twenty reports on the SAME item impossible.
           */
          max: 20,
          timeWindow: '1 hour',
          keyGenerator: (request) => `report:${request.user?.id ?? request.ip}`,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = await requireActor(request);
      const body = parseBody(createReportBody, request.body);
      const result = await service.createReport(actor, body);
      return reply.status(201).ok(result);
    },
  );

  /**
   * A literal path, so it must stay ahead of any future `/:id` route — Fastify
   * matches in registration order, and "mine" would otherwise be read as an id
   * and fail as a malformed UUID.
   */
  app.get(
    '/mine',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = await requireActor(request);
      const pagination = parseQuery(paginationSchema, request.query);
      const { items, total } = await service.listMyReports(actor, pagination);

      return reply.ok(
        items.map((item) => ({
          id: item.id,
          targetType: item.targetType,
          targetId: item.targetId,
          reason: item.reason,
          status: item.status,
          createdAt: item.createdAt.toISOString(),
          resolvedAt: item.resolvedAt ? item.resolvedAt.toISOString() : null,
          resolutionNote: item.resolutionNote,
        })),
        paginationMeta(paginate(items, total, pagination)),
      );
    },
  );

  /**
   * Whether the caller already has an open report on this target.
   *
   * Its own endpoint rather than a flag folded into the document response: the
   * document is cacheable and shared between viewers, while this answer is
   * per-viewer and changes the moment they press the button.
   */
  app.get(
    '/state',
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = await requireActor(request);
      const query = parseQuery(stateQuery, request.query);
      return reply.ok(await service.getReportState(actor, query.targetType, query.targetId));
    },
  );
}
