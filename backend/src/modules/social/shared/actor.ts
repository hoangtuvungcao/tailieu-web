import type { FastifyRequest } from 'fastify';

import { AppError } from '../../../lib/errors.js';
import { getUserModerationScope, getUserPermissions } from '../../rbac/rbac.service.js';
import type { Viewer } from './visibility.js';

/**
 * Build the actor context every social module needs.
 *
 * Shared rather than duplicated per module: the moderation scope is what makes
 * faculty-scoped visibility real, and four copies of the same three lookups is
 * four places for it to drift or be forgotten.
 */
export interface SocialActor {
  userId: string;
  viewer: Viewer;
  permissions: Set<string>;
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export async function buildActor(request: FastifyRequest): Promise<SocialActor | null> {
  if (!request.user) return null;

  const [permissions, scope] = await Promise.all([
    getUserPermissions(request.user.id),
    getUserModerationScope(request.user.id),
  ]);

  return {
    userId: request.user.id,
    permissions,
    viewer: {
      userId: request.user.id,
      isModerator: scope.global,
      facultyIds: scope.facultyIds,
      facultyId: request.user.primaryFacultyId,
      programId: request.user.primaryProgramId,
    },
    ip: request.ip ?? null,
    userAgent: request.headers['user-agent'] ?? null,
    requestId: request.id,
  };
}

export async function requireActor(request: FastifyRequest): Promise<SocialActor> {
  const actor = await buildActor(request);
  if (!actor) {
    throw new AppError('UNAUTHORIZED', 'Authentication is required for this request.');
  }
  return actor;
}
