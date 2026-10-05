import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ErrorCode } from '../lib/errors.js';

/**
 * Type augmentation for the decorators and request properties this application
 * adds to Fastify. Declaring them here means `reply.ok(...)` and
 * `request.user` are type-checked everywhere, instead of failing at runtime on
 * a handler somebody forgot to register the plugin for.
 */
declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by the authenticate preHandler. Absent on public routes. */
    user?: AuthenticatedUser;
    /** Correlation id, echoed in the response and attached to log lines. */
    requestId: string;
    /**
     * Permission set for `user`, resolved once per request and reused by every
     * authorize() check on the route. Lazy — routes without permission checks
     * never pay for the lookup.
     */
    permissions?: Set<string>;
    /** Faculty ids the caller may moderate. `null` means unscoped (global). */
    moderationScope?: { global: boolean; facultyIds: string[] } | null;
  }

  interface FastifyReply {
    /** Success envelope: { success: true, data, message, meta }. */
    ok<T>(data: T, meta?: Record<string, unknown>, message?: string | null): FastifyReply;
    /** Failure envelope built from an AppError-like shape. */
    fail(code: ErrorCode, message: string, details?: Record<string, unknown>): FastifyReply;
  }

  interface FastifyInstance {
    /** Requires a valid access token; 401 otherwise. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Requires a permission. Returns a preHandler.
     * `scope: 'faculty'` additionally requires the caller's scope to cover the
     * target row — enforced in the repository, not by this function alone.
     */
    authorize: (
      permission: string,
      options?: { scope?: 'faculty' },
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Populates request.user when a token is present, but never rejects. */
    optionalAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Resolve the faculty ids a user may moderate. Used by services that need
     * the scope outside a preHandler (for example, listing a moderation queue).
     */
    getModerationScope: (userId: string) => Promise<{ global: boolean; facultyIds: string[] }>;
  }
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  status: 'active' | 'suspended' | 'deactivated';
  emailVerifiedAt: Date | null;
  tokenVersion: number;
  roles: string[];
  sessionId: string;
  primaryFacultyId: string | null;
  primaryProgramId: string | null;
}
