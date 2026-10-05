/**
 * Seed: the initial administrator, a moderator, and a demo student.
 *
 * The administrator is created as `super_admin` because it is the platform
 * owner's bootstrap account and there is no other way to create one — the admin
 * API deliberately cannot grant `super_admin`, so that privilege can never be
 * escalated through the application.
 *
 * Passwords come from the environment and are hashed with Argon2id. Existing
 * accounts are NOT re-hashed on re-run: overwriting a live administrator's
 * password on every deploy would lock them out the moment they changed it.
 * To reset a password, use the password-reset flow or delete the account.
 */
import { eq } from 'drizzle-orm';

import { ROLES } from '../../config/permissions.js';
import { env, isDefaultSeedPassword, isProduction } from '../../config/env.js';
import { hashPassword } from '../../lib/password.js';
import { db } from '../client.js';
import { roles, storageUsage, userRoles, users, authIdentities } from '../schema/index.js';

export interface UsersSeedResult {
  created: string[];
  skipped: string[];
  notes: string[];
}

export async function seedUsers(): Promise<UsersSeedResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  const notes: string[] = [];

  const accounts = [
    {
      email: env.SEED_ADMIN_EMAIL,
      password: env.SEED_ADMIN_PASSWORD,
      displayName: 'Quản trị viên',
      fullName: 'TAILIEU TTN Administrator',
      role: 'super_admin' as const,
    },
    {
      email: env.SEED_MODERATOR_EMAIL,
      password: env.SEED_MODERATOR_PASSWORD,
      displayName: 'Kiểm duyệt viên',
      fullName: 'TAILIEU TTN Moderator',
      role: 'moderator' as const,
    },
    {
      email: env.SEED_STUDENT_EMAIL,
      password: env.SEED_STUDENT_PASSWORD,
      displayName: 'Sinh viên Demo',
      fullName: 'Nguyễn Văn Demo',
      role: 'student' as const,
    },
  ];

  await db.transaction(async (tx) => {
    for (const account of accounts) {
      const email = account.email.toLowerCase();

      const existing = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existing[0]) {
        skipped.push(email);
        continue;
      }

      // Refuse to create an account whose password is published.
      //
      // `.env.example` is in a public repository, so `ChangeMe_Admin_2026` is
      // not a secret — it is a documented default. Seeding with it in
      // production would create a super_admin that anyone who has read the
      // repository can sign in as, and nothing else in the stack would object:
      // the password satisfies the length rule, and the account is marked
      // verified so it can log in immediately.
      //
      // This sits after the `existing[0]` check deliberately. Re-running the
      // seeder on an established deployment must keep working — it is how RBAC
      // and taxonomy updates reach the database — and at that point no account
      // is created, so there is nothing to refuse. The check fires only when a
      // default password is about to become a real credential.
      if (isProduction && isDefaultSeedPassword(account.password)) {
        throw new Error(
          `Refusing to seed ${email} with the published default password in production.\n` +
            `Set SEED_ADMIN_PASSWORD / SEED_MODERATOR_PASSWORD / SEED_STUDENT_PASSWORD ` +
            `to real values in the environment file, then run the seed again.`,
        );
      }

      const [user] = await tx
        .insert(users)
        .values({
          email,
          displayName: account.displayName,
          fullName: account.fullName,
          // Seeded accounts skip email verification: they exist so an operator
          // can log in immediately, and there is no mailbox to verify against.
          emailVerifiedAt: new Date(),
          status: 'active',
        })
        .returning({ id: users.id });

      const userId = user!.id;

      // Password identity lives in its own table so an OAuth identity can be
      // added later without touching `users`.
      await tx.insert(authIdentities).values({
        userId,
        provider: 'password',
        providerUid: email,
        passwordHash: await hashPassword(account.password),
      });

      const [role] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.key, account.role))
        .limit(1);

      if (!role) {
        throw new Error(
          `Role "${account.role}" not found. Run the RBAC seed (01-rbac) before the users seed.`,
        );
      }

      await tx.insert(userRoles).values({ userId, roleId: role.id }).onConflictDoNothing();

      // Every user gets a storage-usage row so uploads never need an upsert on
      // the hot path.
      await tx.insert(storageUsage).values({ userId }).onConflictDoNothing();

      created.push(`${email} (${ROLES[account.role].name})`);
    }
  });

  if (created.length > 0 && isProduction) {
    notes.push(
      'Seeded accounts use passwords from the environment. Change them immediately after ' +
        'the first login, and remove SEED_*_PASSWORD from the production environment file.',
    );
  }

  return { created, skipped, notes };
}
