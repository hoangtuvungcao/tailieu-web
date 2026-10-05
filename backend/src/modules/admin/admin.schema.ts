import { z } from 'zod';

import { paginationSchema } from '../../lib/pagination.js';
import { uuidSchema } from '../../lib/validation.js';

/**
 * Admin request schemas.
 *
 * `reasons` are free text but length-capped: an audit row is read by a human
 * investigating something months later, and an unbounded field is a place to
 * paste an entire document into the audit log.
 */

export const userListQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'suspended', 'deactivated']).optional(),
  role: z.string().trim().max(40).optional(),
  facultyId: uuidSchema.optional(),
});

export const userIdParamSchema = z.object({ id: uuidSchema });
export const sessionParamSchema = z.object({ id: uuidSchema, sessionId: uuidSchema });
export const reportIdParamSchema = z.object({ id: uuidSchema });

export const updateUserSchema = z
  .object({
    status: z.enum(['active', 'suspended', 'deactivated']).optional(),
    primaryFacultyId: z.union([uuidSchema, z.null()]).optional(),
    primaryProgramId: z.union([uuidSchema, z.null()]).optional(),
    displayName: z.string().trim().min(2).max(80).optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const grantRoleSchema = z
  .object({
    // Validated against the catalog in the service, not here — the enum lives
    // in one place (`config/permissions.ts`) and duplicating it in a schema is
    // how the two drift apart.
    roleKey: z.string().trim().min(1).max(40),
    facultyId: z.union([uuidSchema, z.null()]).optional().default(null),
  })
  .strict();

export const auditQuerySchema = paginationSchema.extend({
  actorUserId: uuidSchema.optional(),
  action: z.string().trim().max(80).optional(),
  targetType: z.string().trim().max(40).optional(),
  targetId: z.string().trim().max(80).optional(),
  since: z.string().datetime().optional(),
});

export const timeseriesQuerySchema = z.object({
  metric: z.enum(['users', 'documents', 'downloads', 'uploads']).default('documents'),
  days: z.coerce.number().int().min(7).max(365).default(30),
});

export const reportListQuerySchema = paginationSchema.extend({
  status: z.enum(['pending', 'reviewing', 'resolved', 'rejected']).optional(),
  targetType: z.string().trim().max(40).optional(),
});

export const resolveReportSchema = z
  .object({
    status: z.enum(['resolved', 'rejected', 'reviewing']),
    note: z.string().trim().max(1000).nullish().transform((v) => v ?? null),
  })
  .strict();

export const updateSettingsSchema = z
  .object({
    // A partial map: the settings screen saves only what changed, so an
    // unrelated field being edited elsewhere is not overwritten.
    values: z.record(z.string().min(1).max(80), z.unknown()),
  })
  .strict();
