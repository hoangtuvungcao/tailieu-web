import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { inet } from './custom-types.js';
import { faculties } from './taxonomy.js';
import { users } from './identity.js';

/**
 * Role-based access control.
 *
 * The permission catalog is defined in code (`src/config/permissions.ts`) and
 * mirrored into these tables by the seed. Code is the source of truth: a
 * permission that exists only in the database is invisible to the TypeScript
 * type system and therefore unenforceable at compile time.
 *
 * The backend enforces every permission. Frontend checks exist only to avoid
 * showing buttons that would fail — they are never a security control.
 */

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /**
     * Higher rank wins when comparing roles. Used for "can actor act on this
     * user?" checks — an admin must not be able to ban a super admin.
     */
    rank: smallint('rank').notNull().default(0),
    /** System roles cannot be deleted or renamed through the admin API. */
    isSystem: boolean('is_system').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('roles_key_uq').on(t.key)],
);

export const permissions = pgTable(
  'permissions',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** Namespaced key, e.g. "documents.moderate". */
    key: text('key').notNull(),
    /** "documents" — the resource half of the key. */
    resource: text('resource').notNull(),
    /** "moderate" — the action half of the key. */
    action: text('action').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('permissions_key_uq').on(t.key),
    index('permissions_resource_idx').on(t.resource),
  ],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permissionId] }),
    index('role_permissions_permission_idx').on(t.permissionId),
  ],
);

/**
 * Role grants, optionally scoped to a faculty.
 *
 * `faculty_id IS NULL` means a global grant. A non-null value scopes the grant:
 * a faculty moderator for Information Technology must not be able to moderate
 * a Medicine document. That scoping is enforced in repository SQL, not by
 * hiding UI — see `documents.repository.ts`.
 */
export const userRoles = pgTable(
  'user_roles',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    facultyId: uuid('faculty_id').references(() => faculties.id, { onDelete: 'cascade' }),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NULLS NOT DISTINCT (PG15+): without it, a user could accumulate unlimited
    // duplicate global grants, because NULL != NULL in a unique index so every
    // (user, role, NULL) row would be considered distinct from the last.
    // Expressed as a unique CONSTRAINT rather than a partial index because
    // Postgres does not allow NULLS NOT DISTINCT on a partial index.
    unique('user_roles_unique_grant_uq')
      .on(t.userId, t.roleId, t.facultyId)
      .nullsNotDistinct(),
    index('user_roles_user_idx').on(t.userId),
    index('user_roles_role_idx').on(t.roleId),
  ],
);

/**
 * Append-only audit trail for administrative and security actions.
 *
 * Rows are written in the SAME transaction as the change they describe. A
 * best-effort audit write that happens after the fact loses exactly the events
 * you most need recorded — the ones that failed halfway.
 *
 * Never deleted by application code; retention is handled by partitioning.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Dotted action, e.g. "documents.moderate.approve", "users.change_role". */
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    /** Before/after diff, reason, and any other context. */
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    /** Correlates with the API request log line for the same request. */
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_logs_actor_idx').on(t.actorUserId, t.createdAt.desc()),
    index('audit_logs_action_idx').on(t.action, t.createdAt.desc()),
    index('audit_logs_target_idx').on(t.targetType, t.targetId, t.createdAt.desc()),
    index('audit_logs_created_idx').on(t.createdAt.desc()),
  ],
);
