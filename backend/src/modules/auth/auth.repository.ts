import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

import { db, type Database } from '../../db/client.js';
import {
  authIdentities,
  authTokens,
  refreshTokens,
  roles,
  sessions,
  storageUsage,
  userRoles,
  users,
} from '../../db/schema/index.js';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Auth data access.
 *
 * Every multi-row write here happens inside a transaction passed in by the
 * caller, rather than opening its own. Registration writes four tables and
 * session creation writes three; a partial failure in either would leave an
 * account that cannot log in, or a session with no usable token.
 */

export interface UserWithIdentity {
  id: string;
  email: string;
  displayName: string;
  fullName: string | null;
  avatarUrl: string | null;
  status: 'active' | 'suspended' | 'deactivated';
  emailVerifiedAt: Date | null;
  tokenVersion: number;
  primaryFacultyId: string | null;
  primaryProgramId: string | null;
  passwordHash: string | null;
  identityId: string | null;
  roleKeys: string[];
}

/**
 * Load a user together with their password identity and role keys.
 *
 * Joined in one round trip rather than three sequential queries: the login
 * path is the hottest in the application and the one most worth keeping to a
 * single query.
 */
export async function findUserForLogin(
  email: string,
  executor: Tx | typeof db = db,
): Promise<UserWithIdentity | null> {
  const rows = await executor
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      fullName: users.fullName,
      avatarUrl: users.avatarUrl,
      status: users.status,
      emailVerifiedAt: users.emailVerifiedAt,
      tokenVersion: users.tokenVersion,
      primaryFacultyId: users.primaryFacultyId,
      primaryProgramId: users.primaryProgramId,
      passwordHash: authIdentities.passwordHash,
      identityId: authIdentities.id,
    })
    .from(users)
    // LEFT JOIN so a user created via OAuth (no password identity yet) is still
    // found, and login fails with "wrong credentials" rather than "no account".
    .leftJoin(
      authIdentities,
      and(eq(authIdentities.userId, users.id), eq(authIdentities.provider, 'password')),
    )
    .where(eq(users.email, email))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const roleRows = await executor
    .select({ key: roles.key })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(
      and(
        eq(userRoles.userId, row.id),
        sql`(${userRoles.expiresAt} IS NULL OR ${userRoles.expiresAt} > now())`,
      ),
    );

  return { ...row, roleKeys: roleRows.map((r) => r.key) };
}

export async function findUserById(
  userId: string,
  executor: Tx | typeof db = db,
): Promise<UserWithIdentity | null> {
  const rows = await executor
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      fullName: users.fullName,
      avatarUrl: users.avatarUrl,
      status: users.status,
      emailVerifiedAt: users.emailVerifiedAt,
      tokenVersion: users.tokenVersion,
      primaryFacultyId: users.primaryFacultyId,
      primaryProgramId: users.primaryProgramId,
      passwordHash: authIdentities.passwordHash,
      identityId: authIdentities.id,
    })
    .from(users)
    .leftJoin(
      authIdentities,
      and(eq(authIdentities.userId, users.id), eq(authIdentities.provider, 'password')),
    )
    .where(eq(users.id, userId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const roleRows = await executor
    .select({ key: roles.key })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(
      and(
        eq(userRoles.userId, row.id),
        sql`(${userRoles.expiresAt} IS NULL OR ${userRoles.expiresAt} > now())`,
      ),
    );

  return { ...row, roleKeys: roleRows.map((r) => r.key) };
}

export async function emailExists(email: string): Promise<boolean> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  return rows.length > 0;
}

export async function usernameExists(username: string): Promise<boolean> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  return rows.length > 0;
}

/** Insert the user, their password identity, default role and quota row. */
export async function createUser(
  tx: Tx,
  input: {
    email: string;
    displayName: string;
    fullName: string | null;
    passwordHash: string;
    facultyId: string | null;
    programId: string | null;
    defaultRoleKey: string;
  },
): Promise<{ userId: string }> {
  const [user] = await tx
    .insert(users)
    .values({
      email: input.email,
      displayName: input.displayName,
      fullName: input.fullName,
      primaryFacultyId: input.facultyId,
      primaryProgramId: input.programId,
    })
    .returning({ id: users.id });

  const userId = user!.id;

  await tx.insert(authIdentities).values({
    userId,
    provider: 'password',
    providerUid: input.email,
    passwordHash: input.passwordHash,
    passwordChangedAt: new Date(),
  });

  const [role] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.key, input.defaultRoleKey))
    .limit(1);

  if (!role) {
    // Failing the transaction is correct: an account with no role can log in
    // but can do nothing, which looks like a broken app rather than a bug.
    throw new Error(
      `Default role "${input.defaultRoleKey}" does not exist. Run the RBAC seed before registering users.`,
    );
  }

  await tx.insert(userRoles).values({ userId, roleId: role.id });
  await tx.insert(storageUsage).values({ userId }).onConflictDoNothing();

  return { userId };
}

export async function updatePasswordHash(
  tx: Tx,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await tx
    .update(authIdentities)
    .set({ passwordHash, passwordChangedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(authIdentities.userId, userId), eq(authIdentities.provider, 'password')));
}

export async function markEmailVerified(tx: Tx, userId: string): Promise<void> {
  await tx
    .update(users)
    .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

// --- Sessions and refresh tokens ---------------------------------------------

export async function createSession(
  tx: Tx,
  input: {
    userId: string;
    userAgent: string | null;
    ip: string | null;
    expiresAt: Date;
    csrfTokenHash: Buffer | null;
  },
): Promise<{ sessionId: string }> {
  const [session] = await tx
    .insert(sessions)
    .values({
      userId: input.userId,
      // familyId defaults to the row's own id; set explicitly here so the
      // value is known before the insert returns.
      familyId: sql`gen_random_uuid()`,
      userAgent: input.userAgent,
      ip: input.ip,
      expiresAt: input.expiresAt,
      csrfTokenHash: input.csrfTokenHash,
      lastUsedAt: new Date(),
    })
    .returning({ id: sessions.id, familyId: sessions.familyId });

  // The family id must equal the session id at creation so that "revoke this
  // session family" is a single predicate. Postgres generated it above; align
  // them now that the id exists.
  await tx
    .update(sessions)
    .set({ familyId: session!.id })
    .where(eq(sessions.id, session!.id));

  return { sessionId: session!.id };
}

export async function createRefreshToken(
  tx: Tx,
  input: {
    sessionId: string;
    tokenHash: Buffer;
    parentId: string | null;
    expiresAt: Date;
  },
): Promise<{ tokenId: string }> {
  const [row] = await tx
    .insert(refreshTokens)
    .values({
      sessionId: input.sessionId,
      tokenHash: input.tokenHash,
      parentId: input.parentId,
      expiresAt: input.expiresAt,
    })
    .returning({ id: refreshTokens.id });

  return { tokenId: row!.id };
}

export interface RefreshTokenRecord {
  id: string;
  sessionId: string;
  userId: string;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  sessionRevokedAt: Date | null;
  sessionExpiresAt: Date;
  tokenVersion: number;
  userStatus: 'active' | 'suspended' | 'deactivated';
}

/**
 * Coerce a value coming back from raw SQL into a Date.
 *
 * Drizzle's `execute()` returns `timestamptz` columns as STRINGS, not Dates —
 * raw SQL bypasses pg's type parsers, which only apply to the ORM's own
 * mapping layer. Calling `.getTime()` on one of those values throws
 * "is not a function" deep inside the refresh path, which is both a confusing
 * error and a total authentication outage.
 *
 * Accepting either shape here means the code is correct whether it is fed by
 * raw SQL or by a typed Drizzle query.
 */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Look up a refresh token with its session and user in one query.
 *
 * `FOR UPDATE` on the session row is what makes concurrent refreshes safe: two
 * tabs presenting the same token at the same moment serialise here, so the
 * second one sees `rotated_at` already set and is handled by the grace window
 * rather than racing to create two successor tokens.
 */
export async function lockRefreshTokenRow(
  tx: Tx,
  tokenHash: Buffer,
): Promise<RefreshTokenRecord | null> {
  const rows = await tx.execute<{
    id: string;
    session_id: string;
    user_id: string;
    rotated_at: Date | string | null;
    revoked_at: Date | string | null;
    expires_at: Date | string;
    session_revoked_at: Date | string | null;
    session_expires_at: Date | string;
    token_version: number;
    status: 'active' | 'suspended' | 'deactivated';
  }>(sql`
    SELECT rt.id,
           rt.session_id,
           s.user_id,
           rt.rotated_at,
           rt.revoked_at,
           rt.expires_at,
           s.revoked_at      AS session_revoked_at,
           s.expires_at      AS session_expires_at,
           u.token_version,
           u.status
      FROM refresh_tokens rt
      JOIN sessions s ON s.id = rt.session_id
      JOIN users    u ON u.id = s.user_id
     WHERE rt.token_hash = ${tokenHash}
     LIMIT 1
     FOR UPDATE OF s
  `);

  const row = rows.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    rotatedAt: row.rotated_at === null ? null : toDate(row.rotated_at),
    revokedAt: row.revoked_at === null ? null : toDate(row.revoked_at),
    expiresAt: toDate(row.expires_at),
    sessionRevokedAt: row.session_revoked_at === null ? null : toDate(row.session_revoked_at),
    sessionExpiresAt: toDate(row.session_expires_at),
    tokenVersion: Number(row.token_version),
    userStatus: row.status,
  };
}

/** The successor of a rotated token, if one was already issued. */
export async function findSuccessorToken(
  tx: Tx,
  parentId: string,
): Promise<{ id: string; rotatedAt: Date | null } | null> {
  const rows = await tx
    .select({ id: refreshTokens.id, rotatedAt: refreshTokens.rotatedAt })
    .from(refreshTokens)
    .where(eq(refreshTokens.parentId, parentId))
    .limit(1);
  return rows[0] ?? null;
}

export async function markTokenRotated(tx: Tx, tokenId: string): Promise<void> {
  await tx
    .update(refreshTokens)
    .set({ rotatedAt: new Date() })
    .where(eq(refreshTokens.id, tokenId));
}

export async function touchSession(tx: Tx, sessionId: string): Promise<void> {
  // last_used_at only. expires_at is deliberately NOT extended: the session
  // has an absolute lifetime, so a stolen refresh token cannot be kept alive
  // indefinitely by simply using it.
  await tx
    .update(sessions)
    .set({ lastUsedAt: new Date() })
    .where(eq(sessions.id, sessionId));
}

/** Revoke an entire session family and every token inside it. */
export async function revokeSessionFamily(
  tx: Tx,
  sessionId: string,
  reason: string,
): Promise<void> {
  const now = new Date();
  await tx
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(eq(sessions.id, sessionId));

  await tx
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(refreshTokens.sessionId, sessionId), isNull(refreshTokens.revokedAt)));
}

export async function revokeSession(
  tx: Tx,
  sessionId: string,
  userId: string,
  reason: string,
): Promise<void> {
  const now = new Date();
  await tx
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));

  await tx
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(refreshTokens.sessionId, sessionId), isNull(refreshTokens.revokedAt)));
}

export async function revokeAllUserSessions(
  tx: Tx,
  userId: string,
  reason: string,
): Promise<number> {
  const now = new Date();

  const revoked = await tx
    .update(sessions)
    .set({ revokedAt: now, revokedReason: reason })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });

  const sessionIds = revoked.map((s) => s.id);
  if (sessionIds.length > 0) {
    await tx
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(
        and(
          sql`${refreshTokens.sessionId} IN ${sessionIds}`,
          isNull(refreshTokens.revokedAt),
        ),
      );
  }

  return sessionIds.length;
}

/**
 * Invalidate every access token ever issued to this user.
 *
 * This is the escalation that turns a refresh-token compromise into a complete
 * session kill: revoking refresh tokens alone leaves the attacker's current
 * 15-minute access token working, which is more than enough time to cause
 * damage.
 */
export async function bumpTokenVersion(tx: Tx, userId: string): Promise<void> {
  await tx
    .update(users)
    .set({ tokenVersion: sql`${users.tokenVersion} + 1`, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function listActiveSessions(userId: string) {
  return db
    .select({
      id: sessions.id,
      userAgent: sessions.userAgent,
      ip: sessions.ip,
      createdAt: sessions.createdAt,
      lastUsedAt: sessions.lastUsedAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(sessions.lastUsedAt));
}

// --- Verification / reset tokens ---------------------------------------------

export async function createAuthToken(
  tx: Tx,
  input: {
    userId: string;
    type: 'email_verification' | 'password_reset';
    tokenHash: Buffer;
    expiresAt: Date;
  },
): Promise<void> {
  // Supersede any outstanding token of the same type: two live reset links for
  // one account means the older one is an unrevoked credential sitting in an
  // inbox.
  await tx
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(authTokens.userId, input.userId),
        eq(authTokens.type, input.type),
        isNull(authTokens.consumedAt),
      ),
    );

  await tx.insert(authTokens).values({
    userId: input.userId,
    type: input.type,
    tokenHash: input.tokenHash,
    expiresAt: input.expiresAt,
  });
}

/**
 * Consume a single-use token.
 *
 * The `consumed_at IS NULL` predicate is part of the UPDATE, not a preceding
 * SELECT — that is what makes redemption atomic. Checking first and updating
 * second would let two concurrent requests both observe an unused token and
 * both succeed.
 */
export async function consumeAuthToken(
  tx: Tx,
  tokenHash: Buffer,
  type: 'email_verification' | 'password_reset',
): Promise<{ userId: string } | null> {
  const rows = await tx
    .update(authTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(authTokens.tokenHash, tokenHash),
        eq(authTokens.type, type),
        isNull(authTokens.consumedAt),
        gt(authTokens.expiresAt, new Date()),
      ),
    )
    .returning({ userId: authTokens.userId });

  return rows[0] ?? null;
}

/** Role keys granted to a user, used to mint access tokens. */
export async function selectRoleKeys(userId: string, executor: Tx | typeof db = db): Promise<string[]> {
  const rows = await executor
    .select({ key: roles.key })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(
      and(
        eq(userRoles.userId, userId),
        sql`(${userRoles.expiresAt} IS NULL OR ${userRoles.expiresAt} > now())`,
      ),
    );
  return rows.map((r) => r.key);
}
