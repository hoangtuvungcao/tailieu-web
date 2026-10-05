/**
 * Seed: roles, permissions and their mapping.
 *
 * Idempotent by design — every statement upserts on a natural key, so running
 * the seed twice is a no-op rather than a duplicate-key crash. That matters
 * because this runs on every deploy: permissions added to
 * `config/permissions.ts` must appear in the database without anyone
 * remembering to write a migration.
 *
 * The code catalog is authoritative. Permissions that exist in the database but
 * not in the catalog are REPORTED, not silently deleted — a stale row might
 * still be referenced by a role grant, and silently removing a permission is
 * how an access-control regression ships unnoticed.
 */
import { and, eq, inArray, notInArray } from 'drizzle-orm';

import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  ROLES,
  ROLE_KEYS,
  parsePermissionKey,
} from '../../config/permissions.js';
import { db } from '../client.js';
import { permissions, rolePermissions, roles } from '../schema/index.js';

export interface SeedResult {
  inserted: number;
  updated: number;
  notes: string[];
}

export async function seedRbac(): Promise<SeedResult> {
  const notes: string[] = [];
  let inserted = 0;

  // --- permissions ---------------------------------------------------------
  await db.transaction(async (tx) => {
    for (const key of ALL_PERMISSIONS) {
      const { resource, action } = parsePermissionKey(key);
      const description = PERMISSIONS[key];

      const existing = await tx
        .select({ id: permissions.id })
        .from(permissions)
        .where(eq(permissions.key, key))
        .limit(1);

      if (existing.length === 0) {
        await tx.insert(permissions).values({ key, resource, action, description });
        inserted += 1;
      } else {
        // Keep descriptions in sync with the catalog so the admin UI never
        // shows stale wording.
        await tx
          .update(permissions)
          .set({ resource, action, description })
          .where(eq(permissions.key, key));
      }
    }

    // --- roles -------------------------------------------------------------
    for (const roleKey of ROLE_KEYS) {
      const definition = ROLES[roleKey];
      const existing = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.key, roleKey))
        .limit(1);

      if (existing.length === 0) {
        await tx.insert(roles).values({
          key: definition.key,
          name: definition.name,
          description: definition.description,
          rank: definition.rank,
          isSystem: true,
        });
        inserted += 1;
      } else {
        await tx
          .update(roles)
          .set({
            name: definition.name,
            description: definition.description,
            rank: definition.rank,
          })
          .where(eq(roles.key, roleKey));
      }
    }

    // --- role -> permission mapping ----------------------------------------
    // Rebuilt wholesale rather than diffed. A grant removed from the catalog
    // must disappear from the database, and computing the exact delta buys
    // nothing when the whole table is a few dozen rows.
    const roleRows = await tx.select({ id: roles.id, key: roles.key }).from(roles);
    const permissionRows = await tx.select({ id: permissions.id, key: permissions.key }).from(permissions);

    const roleIdByKey = new Map(roleRows.map((r) => [r.key, r.id]));
    const permissionIdByKey = new Map(permissionRows.map((p) => [p.key, p.id]));

    for (const roleKey of ROLE_KEYS) {
      const roleId = roleIdByKey.get(roleKey);
      if (!roleId) continue;

      const wanted = new Set(ROLES[roleKey].permissions);
      const wantedIds = [...wanted]
        .map((key) => permissionIdByKey.get(key))
        .filter((id): id is string => id !== undefined);

      // Drop grants that are no longer in the catalog.
      const current = await tx
        .select({ permissionId: rolePermissions.permissionId })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, roleId));

      const stale = current
        .map((r) => r.permissionId)
        .filter((id) => !wantedIds.includes(id));

      if (stale.length > 0) {
        // Scoped to THIS role. Without the roleId predicate this would delete
        // the permission from every role that holds it — a silent, catastrophic
        // privilege regression that no test would notice until someone tried to
        // moderate something.
        await tx
          .delete(rolePermissions)
          .where(
            and(
              eq(rolePermissions.roleId, roleId),
              inArray(rolePermissions.permissionId, stale),
            ),
          );
      }

      if (wantedIds.length > 0) {
        await tx
          .insert(rolePermissions)
          .values(wantedIds.map((permissionId) => ({ roleId, permissionId })))
          .onConflictDoNothing();
      }
    }

    // --- report unknown permissions ---------------------------------------
    // A permission present in the database but absent from the catalog is
    // either a leftover from a removed feature or a typo someone inserted by
    // hand. Either way an operator should know, because it may still be
    // granted to a role.
    const known = ALL_PERMISSIONS as string[];
    const unknown = await tx
      .select({ key: permissions.key })
      .from(permissions)
      .where(notInArray(permissions.key, known));

    if (unknown.length > 0) {
      notes.push(
        `Permissions exist in the database but not in config/permissions.ts: ${unknown
          .map((u) => u.key)
          .join(', ')}. Review whether they are still granted to any role.`,
      );
    }
  });

  return {
    inserted,
    updated: 0,
    notes: [...notes, `${ROLE_KEYS.length} roles, ${ALL_PERMISSIONS.length} permissions synchronised.`],
  };
}
