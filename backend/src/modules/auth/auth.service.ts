import { eq } from 'drizzle-orm';

import { DEFAULT_ROLE } from '../../config/permissions.js';
import { durations, env, getFrontendUrl } from '../../config/env.js';
import { db } from '../../db/client.js';
import { sessions, users } from '../../db/schema/index.js';
import { recordAudit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { accessTokenTtlSeconds, signAccessToken } from '../../lib/jwt.js';
import { getMailer } from '../../lib/mailer/index.js';
import { hashPassword, needsRehash, verifyPassword, burnPasswordTime } from '../../lib/password.js';
import {
  generateCsrfToken,
  generateEmailVerificationToken,
  generatePasswordResetToken,
  generateRefreshToken,
  hashToken,
} from '../../lib/tokens.js';
import { invalidatePermissionCaches, markSessionRevoked } from '../rbac/rbac.service.js';
import * as repo from './auth.repository.js';
import * as profileImages from './profile-image.service.js';
import type { ProfileImageKind } from './profile-image.service.js';
import { checkLoginThrottle, clearLoginFailures, recordLoginFailure } from './login-throttle.js';
import type { UpdateProfileInput } from './auth.schema.js';

/**
 * Authentication service.
 *
 * The refresh-token rotation below is the most security-sensitive code in the
 * project. It implements reuse detection: if an already-rotated token is
 * presented, that is proof the token was captured (the legitimate client would
 * hold the successor), and the entire session family is destroyed along with
 * every outstanding access token.
 */

export interface RequestContext {
  userAgent: string | null;
  ip: string | null;
  requestId: string;
  /**
   * Who performed the action, when it is an authenticated one.
   *
   * Optional because the auth flows that use this context (register, login) run
   * before an identity exists. Administrative services set it from
   * `request.user.id` so their audit rows name an actor.
   */
  actorUserId?: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /**
   * Only issued at login and registration. Refresh deliberately does NOT
   * rotate the CSRF token: it is already bound to the session, and rotating it
   * on every refresh leaves a second browser tab holding a stale value that
   * fails the very next state-changing request.
   */
  csrfToken?: string;
  expiresIn: number;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  fullName: string | null;
  username: string | null;
  bio: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  emailVerified: boolean;
  roles: string[];
  primaryFacultyId: string | null;
  primaryProgramId: string | null;
}

function toPublicUser(user: repo.UserWithIdentity): PublicUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    fullName: user.fullName,
    username: user.username,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    coverUrl: user.coverUrl,
    emailVerified: user.emailVerifiedAt !== null,
    roles: user.roleKeys,
    primaryFacultyId: user.primaryFacultyId,
    primaryProgramId: user.primaryProgramId,
  };
}

/** A friendly session label derived from the user agent, for the device list. */
function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'Thiết bị không xác định';

  const ua = userAgent.toLowerCase();
  const browser = ua.includes('edg/')
    ? 'Edge'
    : ua.includes('chrome/') && !ua.includes('chromium')
      ? 'Chrome'
      : ua.includes('firefox/')
        ? 'Firefox'
        : ua.includes('safari/') && !ua.includes('chrome')
          ? 'Safari'
          : 'Trình duyệt khác';

  const os = ua.includes('windows')
    ? 'Windows'
    : ua.includes('android')
      ? 'Android'
      : ua.includes('iphone') || ua.includes('ipad')
        ? 'iOS'
        : ua.includes('mac os')
          ? 'macOS'
          : ua.includes('linux')
            ? 'Linux'
            : '';

  return os ? `${browser} trên ${os}` : browser;
}

// =============================================================================
// Registration
// =============================================================================

export async function register(
  input: {
    email: string;
    password: string;
    displayName: string;
    fullName: string | null;
    facultyId: string | null;
    programId: string | null;
  },
  context: RequestContext,
): Promise<{ user: PublicUser; tokens: AuthTokens }> {
  if (await repo.emailExists(input.email)) {
    // This does disclose that an address is registered. The alternative —
    // accepting the registration and emailing "someone tried to use your
    // address" — is better for privacy but much worse for usability on a
    // university platform where students legitimately forget they signed up.
    // Rate limiting on this endpoint bounds the enumeration value.
    throw new AppError('AUTH_EMAIL_TAKEN', 'This email address is already registered.');
  }

  const passwordHash = await hashPassword(input.password);

  const { user, tokens } = await db.transaction(async (tx) => {
    const { userId } = await repo.createUser(tx, {
      email: input.email,
      displayName: input.displayName,
      fullName: input.fullName,
      passwordHash,
      facultyId: input.facultyId,
      programId: input.programId,
      defaultRoleKey: DEFAULT_ROLE,
    });

    const created = await repo.findUserById(userId, tx);
    if (!created) throw new Error('User vanished immediately after creation.');

    const issued = await issueSession(tx, created, context);
    return { user: created, tokens: issued };
  });

  // Fire-and-forget: a mail outage must not fail a registration that already
  // committed. The user can request another verification email.
  void sendVerificationEmail(user.id, user.email, user.displayName);

  return { user: toPublicUser(user), tokens };
}

// =============================================================================
// Login
// =============================================================================

export async function login(
  input: { email: string; password: string },
  context: RequestContext,
): Promise<{ user: PublicUser; tokens: AuthTokens }> {
  // Per-account lockout, checked before any password work.
  //
  // The route-level rate limit is keyed on IP because Fastify's keyGenerator
  // runs before the body is parsed, so it cannot see the email — which means it
  // does nothing against credential stuffing spread across many addresses.
  // This is the control that does.
  //
  // Checked first for a second reason: a locked account then costs one Redis
  // read instead of a 64 MiB Argon2 hash, so an attacker cannot exhaust the
  // process's memory budget by hammering accounts that are already locked.
  await checkLoginThrottle(input.email);

  const user = await repo.findUserForLogin(input.email);

  // No such account. Burn equivalent CPU time before failing, otherwise the
  // ~80ms difference between this path and a real password check is a reliable
  // account-enumeration oracle.
  if (!user) {
    await burnPasswordTime();
    await recordLoginFailure(input.email);
    throw new AppError('AUTH_INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }

  // Account exists but has no password identity (created via OAuth). Same
  // generic error, same timing burn — no oracle here either.
  if (!user.passwordHash) {
    await burnPasswordTime();
    await recordLoginFailure(input.email);
    throw new AppError('AUTH_INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }

  const passwordValid = await verifyPassword(user.passwordHash, input.password);
  if (!passwordValid) {
    // Counted for nonexistent addresses too — counting only real accounts would
    // make the lockout itself reveal which addresses are registered.
    await recordLoginFailure(input.email);
    throw new AppError('AUTH_INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }

  // Successful sign-in clears the streak. Otherwise a user who mistyped nine
  // times last week and then succeeded would be one slip from a lockout.
  await clearLoginFailures(input.email);

  // Status is checked AFTER the password so that a suspended-account message
  // is only ever shown to someone who proved they own the account.
  if (user.status === 'suspended') {
    throw new AppError(
      'AUTH_ACCOUNT_SUSPENDED',
      'This account is suspended. Please contact the administrators.',
    );
  }
  if (user.status === 'deactivated') {
    throw new AppError('AUTH_ACCOUNT_DEACTIVATED', 'This account has been deactivated.');
  }

  const { tokens } = await db.transaction(async (tx) => {
    // Transparently upgrade a hash made with weaker parameters. This is the
    // only moment the plaintext is available, so it is the only place a
    // rehash can happen.
    if (needsRehash(user.passwordHash!)) {
      const upgraded = await hashPassword(input.password);
      await repo.updatePasswordHash(tx, user.id, upgraded);
    }

    await tx
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));

    return { tokens: await issueSession(tx, user, context) };
  });

  return { user: toPublicUser(user), tokens };
}

// =============================================================================
// Session issuance and refresh rotation
// =============================================================================

async function issueSession(
  tx: repo.Tx,
  user: repo.UserWithIdentity,
  context: RequestContext,
): Promise<AuthTokens> {
  const csrfToken = generateCsrfToken();

  const { sessionId } = await repo.createSession(tx, {
    userId: user.id,
    userAgent: context.userAgent,
    ip: context.ip,
    // Absolute lifetime, set once. Rotation never extends it.
    expiresAt: new Date(Date.now() + durations.sessionAbsoluteMs),
    csrfTokenHash: hashToken(csrfToken),
  });

  const refresh = generateRefreshToken();
  await repo.createRefreshToken(tx, {
    sessionId,
    tokenHash: refresh.hash,
    parentId: null,
    expiresAt: new Date(Date.now() + durations.refreshTokenMs),
  });

  const accessToken = await signAccessToken({
    sub: user.id,
    sid: sessionId,
    tv: user.tokenVersion,
    roles: user.roleKeys,
  });

  return {
    accessToken,
    refreshToken: refresh.raw,
    csrfToken,
    expiresIn: accessTokenTtlSeconds(),
  };
}

/**
 * Rotate a refresh token.
 *
 * The algorithm, and why each branch exists:
 *
 *   unknown hash        -> 401. Either forged or from a wiped database.
 *   session revoked      -> 401. Already handled; do not re-revoke.
 *   token revoked        -> REUSE. An explicitly revoked token being presented
 *                           means someone kept a copy after revocation.
 *   token rotated        -> REUSE, unless we are inside the grace window and
 *                           the successor is itself unused, which is the
 *                           benign two-tabs-refresh-at-once race.
 *   expired              -> 401, and do NOT revoke the family. Expiry is
 *                           normal, not evidence of theft.
 *
 * The reuse case is returned from the transaction rather than thrown inside it.
 * That is essential: Drizzle rolls back on a thrown error, so revoking the
 * family and writing the audit row inside the same transaction that then
 * throws would discard both — leaving the stolen refresh token still usable,
 * which is the exact opposite of the intent.
 *
 * Everything else runs inside one transaction with the session row locked, so
 * two concurrent refreshes serialise instead of both minting a successor.
 */
export async function refresh(
  rawToken: string,
  context: RequestContext,
): Promise<{ user: PublicUser; tokens: AuthTokens }> {
  const tokenHash = hashToken(rawToken);

  const outcome = await db.transaction(async (tx) => {
    const record = await repo.lockRefreshTokenRow(tx, tokenHash);

    if (!record) {
      throw new AppError('AUTH_REFRESH_INVALID', 'Your session is no longer valid. Please sign in again.');
    }

    // --- Already-revoked session -------------------------------------------
    // Re-revoking would be a no-op, and bumping token_version again would
    // punish the user for a request that is simply late.
    if (record.sessionRevokedAt !== null) {
      throw new AppError('AUTH_SESSION_REVOKED', 'This session has been signed out.');
    }

    // --- Explicitly revoked token ------------------------------------------
    if (record.revokedAt !== null) {
      return { kind: 'reuse' as const, record };
    }

    // --- Already rotated ----------------------------------------------------
    if (record.rotatedAt !== null) {
      const withinGrace = Date.now() - record.rotatedAt.getTime() <= env.REFRESH_GRACE_MS;

      if (withinGrace) {
        const successor = await repo.findSuccessorToken(tx, record.id);

        // A successor that has not itself been rotated means the legitimate
        // client already got a new token and this is the second of two
        // simultaneous requests. Tell the client to retry — by then the
        // browser will be sending the successor cookie.
        if (successor && successor.rotatedAt === null) {
          throw new AppError(
            'AUTH_REFRESH_RACE',
            'Two refresh requests arrived at once. Retry the request.',
            { retryAfterSeconds: 1 },
          );
        }
      }

      // Outside the grace window, or the successor was itself already used:
      // this token is being replayed.
      return { kind: 'reuse' as const, record };
    }

    // --- Expired ------------------------------------------------------------
    // Not a security event. Do not revoke the family: an honest client that
    // was offline for a month must be able to log in again without drama.
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new AppError('AUTH_REFRESH_EXPIRED', 'Your session has expired. Please sign in again.');
    }

    // A token cannot outlive the session that owns it.
    if (record.sessionExpiresAt.getTime() <= Date.now()) {
      throw new AppError('AUTH_REFRESH_EXPIRED', 'Your session has expired. Please sign in again.');
    }

    if (record.userStatus !== 'active') {
      throw new AppError('AUTH_ACCOUNT_SUSPENDED', 'This account is not active.');
    }

    // --- Happy path: rotate -------------------------------------------------
    const user = await repo.findUserById(record.userId, tx);
    if (!user) {
      throw new AppError('AUTH_REFRESH_INVALID', 'This account no longer exists.');
    }

    await repo.markTokenRotated(tx, record.id);

    const next = generateRefreshToken();
    await repo.createRefreshToken(tx, {
      sessionId: record.sessionId,
      tokenHash: next.hash,
      parentId: record.id,
      expiresAt: new Date(Date.now() + durations.refreshTokenMs),
    });

    // last_used_at only — never extends the session's absolute expiry.
    await repo.touchSession(tx, record.sessionId);

    // Re-read token_version so the new access token carries the CURRENT value.
    // Minting with a stale copy would immediately 401 the client.
    const accessToken = await signAccessToken({
      sub: user.id,
      sid: record.sessionId,
      tv: record.tokenVersion,
      roles: user.roleKeys,
    });

    // No csrfToken here on purpose: the session's existing CSRF cookie stays
    // valid. Re-issuing one would strand any other open tab.
    return {
      kind: 'ok' as const,
      user,
      tokens: {
        accessToken,
        refreshToken: next.raw,
        expiresIn: accessTokenTtlSeconds(),
      },
    };
  });

  if (outcome.kind === 'reuse') {
    // Committed in its own transaction, so the revocation and the audit row
    // survive the error we are about to raise.
    await respondToReuse(outcome.record, context);
    throw new AppError(
      'AUTH_REFRESH_REUSE',
      'This session was ended for security reasons. Please sign in again.',
    );
  }

  return { user: toPublicUser(outcome.user), tokens: outcome.tokens };
}

/**
 * Response to a replayed refresh token.
 *
 * Runs in its OWN transaction so it commits independently of the failed
 * refresh. Three things happen together, and all three are necessary:
 *
 *   1. The session family is revoked — every descendant token dies, including
 *      the one the attacker holds.
 *   2. `token_version` is bumped — this is what kills the attacker's still-valid
 *      access token. Without it they keep working for up to 15 minutes.
 *   3. An audit row is written in the same transaction as the revocation,
 *      because this is exactly the event that must not be lost.
 */
async function respondToReuse(
  record: repo.RefreshTokenRecord,
  context: RequestContext,
): Promise<void> {
  await db.transaction(async (tx) => {
    await repo.revokeSessionFamily(tx, record.sessionId, 'rotated_reuse');
    await repo.bumpTokenVersion(tx, record.userId);

    await recordAudit(tx, {
      action: 'auth.refresh_reuse_detected',
      actorUserId: record.userId,
      targetType: 'session',
      targetId: record.sessionId,
      metadata: {
        reason: 'A refresh token that had already been rotated was presented.',
      },
      ip: context.ip,
      userAgent: context.userAgent,
      requestId: context.requestId,
    });
  });

  // Only after the revocation is durable. The cache would otherwise keep
  // reporting this session as live for up to a minute, which is precisely the
  // window an attacker would use — but writing it before the commit would
  // leave the cache claiming a revocation that a rollback had undone.
  await markSessionRevoked(record.sessionId);
}

// =============================================================================
// Logout
// =============================================================================

export async function logout(sessionId: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await repo.revokeSession(tx, sessionId, userId, 'logout');
  });
  await markSessionRevoked(sessionId);
}

export async function logoutAll(userId: string): Promise<number> {
  const count = await db.transaction(async (tx) => {
    const revoked = await repo.revokeAllUserSessions(tx, userId, 'logout_all');
    // Bumping the version is what makes "log out everywhere" actually mean
    // everywhere — it kills outstanding access tokens too, not just the
    // refresh tokens.
    await repo.bumpTokenVersion(tx, userId);
    return revoked;
  });

  await invalidatePermissionCaches();
  return count;
}

export async function listSessions(userId: string, currentSessionId: string) {
  const rows = await repo.listActiveSessions(userId);
  return rows.map((session) => ({
    id: session.id,
    device: describeUserAgent(session.userAgent),
    ip: session.ip,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    expiresAt: session.expiresAt,
    current: session.id === currentSessionId,
  }));
}

export async function revokeSession(
  userId: string,
  sessionId: string,
  currentSessionId: string,
): Promise<void> {
  if (sessionId === currentSessionId) {
    throw new AppError(
      'CANNOT_MODIFY_SELF',
      'Use sign out to end your current session.',
    );
  }

  await db.transaction(async (tx) => {
    await repo.revokeSession(tx, sessionId, userId, 'admin');
  });
  await markSessionRevoked(sessionId);
}

// =============================================================================
// Email verification and password reset
// =============================================================================

export async function sendVerificationEmail(
  userId: string,
  email: string,
  displayName: string,
): Promise<void> {
  const token = generateEmailVerificationToken();

  await db.transaction(async (tx) => {
    await repo.createAuthToken(tx, {
      userId,
      type: 'email_verification',
      tokenHash: token.hash,
      // Long window: a student may not check their inbox for days, and a
      // verification link is low-risk compared with a reset link.
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
  });

  const link = `${getFrontendUrl()}/verify-email?token=${token.raw}`;

  await getMailer().send({
    to: email,
    subject: 'Xác minh địa chỉ email — TAILIEU TTN',
    text: [
      `Xin chào ${displayName},`,
      '',
      'Cảm ơn bạn đã đăng ký tài khoản TAILIEU TTN.',
      'Vui lòng xác minh địa chỉ email bằng liên kết dưới đây:',
      '',
      link,
      '',
      'Liên kết này có hiệu lực trong 7 ngày.',
      'Nếu bạn không thực hiện đăng ký này, hãy bỏ qua email này.',
      '',
      '— TAILIEU TTN',
    ].join('\n'),
  });
}

export async function resendVerification(userId: string): Promise<void> {
  const user = await repo.findUserById(userId);
  if (!user) throw new AppError('USER_NOT_FOUND', 'Account not found.');

  if (user.emailVerifiedAt) {
    throw new AppError('CONFLICT', 'This email address is already verified.');
  }

  await sendVerificationEmail(user.id, user.email, user.displayName);
}

export async function verifyEmail(rawToken: string): Promise<void> {
  const tokenHash = hashToken(rawToken);

  await db.transaction(async (tx) => {
    const consumed = await repo.consumeAuthToken(tx, tokenHash, 'email_verification');
    if (!consumed) {
      // Covers expired, already-used, and fabricated tokens with one message.
      // Distinguishing them would tell an attacker whether a token existed.
      throw new AppError(
        'AUTH_TOKEN_CONSUMED',
        'This verification link is invalid or has already been used.',
      );
    }
    await repo.markEmailVerified(tx, consumed.userId);
  });
}

export async function requestPasswordReset(email: string): Promise<void> {
  const user = await repo.findUserForLogin(email);

  // Always report success, whether or not the account exists. Returning 404
  // here would turn the reset form into a free account-enumeration endpoint.
  if (!user || user.status !== 'active') {
    // Burn comparable time so the response latency does not leak the answer.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return;
  }

  const token = generatePasswordResetToken();

  await db.transaction(async (tx) => {
    await repo.createAuthToken(tx, {
      userId: user.id,
      type: 'password_reset',
      tokenHash: token.hash,
      // Short window: this token takes over an account outright.
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  });

  const link = `${getFrontendUrl()}/reset-password?token=${token.raw}`;

  await getMailer().send({
    to: user.email,
    subject: 'Đặt lại mật khẩu — TAILIEU TTN',
    text: [
      `Xin chào ${user.displayName},`,
      '',
      'Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản của bạn.',
      '',
      link,
      '',
      'Liên kết này có hiệu lực trong 1 giờ và chỉ sử dụng được một lần.',
      'Nếu bạn không yêu cầu điều này, hãy bỏ qua email — mật khẩu của bạn vẫn an toàn.',
      '',
      '— TAILIEU TTN',
    ].join('\n'),
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px; background-color: #ffffff;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h2 style="color: #1e3a8a; margin: 0; font-size: 20px;">TAILIEU TTN</h2>
          <p style="color: #6b7280; font-size: 13px; margin: 4px 0 0;">Kho tri thức cộng đồng Đại học Tây Nguyên</p>
        </div>
        <p style="color: #1f2937; font-size: 15px; line-height: 1.6;">Xin chào <strong>${user.displayName}</strong>,</p>
        <p style="color: #1f2937; font-size: 15px; line-height: 1.6;">Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản TAILIEU TTN của bạn. Nhấn vào nút bên dưới để tiến hành đổi mật khẩu mới:</p>
        <div style="text-align: center; margin: 28px 0;">
          <a href="${link}" style="background-color: #2563eb; color: #ffffff; padding: 12px 28px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; display: inline-block;">Đặt lại mật khẩu</a>
        </div>
        <p style="color: #6b7280; font-size: 13px; line-height: 1.5;">Hoặc bạn có thể sao chép liên kết này vào trình duyệt:<br/><a href="${link}" style="color: #2563eb; word-break: break-all;">${link}</a></p>
        <hr style="border: none; border-top: 1px solid #f3f4f6; margin: 24px 0;" />
        <p style="color: #ef4444; font-size: 12px; margin-bottom: 6px;">⚠️ Liên kết có hiệu lực trong 1 giờ và chỉ sử dụng được 1 lần.</p>
        <p style="color: #9ca3af; font-size: 12px; margin: 0;">Nếu bạn không yêu cầu đổi mật khẩu, vui lòng bỏ qua email này. Mật khẩu của bạn vẫn an toàn tuyệt đối.</p>
      </div>
    `,
  });
}

export async function resetPassword(rawToken: string, newPassword: string): Promise<void> {
  const tokenHash = hashToken(rawToken);
  const passwordHash = await hashPassword(newPassword);

  await db.transaction(async (tx) => {
    const consumed = await repo.consumeAuthToken(tx, tokenHash, 'password_reset');
    if (!consumed) {
      throw new AppError(
        'AUTH_TOKEN_CONSUMED',
        'This reset link is invalid or has already been used.',
      );
    }

    await repo.updatePasswordHash(tx, consumed.userId, passwordHash);

    // Assume the worst: a reset is often triggered *because* the account was
    // compromised. Kill every session and bump the token version so any
    // attacker access token dies immediately.
    await repo.revokeAllUserSessions(tx, consumed.userId, 'password_change');
    await repo.bumpTokenVersion(tx, consumed.userId);

    await recordAudit(tx, {
      action: 'auth.password_reset_completed',
      actorUserId: consumed.userId,
      targetType: 'user',
      targetId: consumed.userId,
      metadata: { sessionsRevoked: true, tokenVersionBumped: true },
    });
  });

  await invalidatePermissionCaches();
}

export async function getCurrentUser(userId: string): Promise<PublicUser> {
  const user = await repo.findUserById(userId);
  if (!user) throw new AppError('USER_NOT_FOUND', 'Account not found.');
  return toPublicUser(user);
}

/**
 * Change the parts of a profile a person owns.
 *
 * Every field is optional and an absent one is left untouched; an explicitly
 * null one is cleared. The distinction is the whole reason the request schema
 * uses `.nullish()` rather than `.optional().default(null)` — only one of those
 * lets a user delete their bio without also deleting their display name.
 *
 * The username needs a uniqueness check the schema cannot express, because it
 * is a property of the table rather than of the string. The check and the write
 * share a transaction, and the unique index is still the real guarantee: two
 * simultaneous claims both pass the check and one hits the constraint, which
 * surfaces as the same "already taken" message rather than a 500.
 */
export async function updateProfile(
  userId: string,
  input: UpdateProfileInput,
): Promise<PublicUser> {
  const fields: {
    displayName?: string;
    fullName?: string | null;
    bio?: string | null;
    username?: string | null;
  } = {};

  if (input.displayName !== undefined) fields.displayName = input.displayName;
  if (input.fullName !== undefined) fields.fullName = input.fullName;
  if (input.bio !== undefined) fields.bio = input.bio;
  // An empty string is how a form reports "I cleared this", and for a username
  // that means the column goes back to null rather than to an empty string.
  if (input.username !== undefined) {
    fields.username = input.username === '' || input.username === null ? null : input.username;
  }

  await db.transaction(async (tx) => {
    if (fields.username) {
      if (await repo.usernameTakenByOther(fields.username, userId, tx)) {
        throw new AppError('AUTH_USERNAME_TAKEN', 'Tên người dùng này đã có người sử dụng.');
      }
    }

    await repo.updateProfileFields(tx, userId, fields);

    await recordAudit(tx, {
      action: 'user.profile_updated',
      actorUserId: userId,
      targetType: 'user',
      targetId: userId,
      // The field names, never the values. A bio can carry anything, and an
      // audit log is read by more people than the profile is.
      metadata: { fields: Object.keys(fields) },
    });
  });

  return getCurrentUser(userId);
}

export type { ProfileImageKind };

/**
 * Replace or clear an avatar or cover image.
 *
 * Split out from `updateProfile` because the payload is a file rather than
 * JSON and it is validated against the bytes; the two only share a subject.
 */
export async function replaceProfileImage(
  userId: string,
  kind: ProfileImageKind,
  buffer: Buffer,
  originalName: string,
  declaredMime: string | null,
): Promise<PublicUser> {
  const current = await repo.findUserById(userId);
  if (!current) throw new AppError('USER_NOT_FOUND', 'Account not found.');

  const previous = kind === 'avatar' ? current.avatarUrl : current.coverUrl;

  await profileImages.replace(userId, kind, buffer, originalName, declaredMime, previous);

  await recordAudit(db, {
    action: kind === 'avatar' ? 'user.avatar_updated' : 'user.cover_updated',
    actorUserId: userId,
    targetType: 'user',
    targetId: userId,
    metadata: { kind },
  });

  return getCurrentUser(userId);
}

export async function clearProfileImage(
  userId: string,
  kind: ProfileImageKind,
): Promise<PublicUser> {
  const current = await repo.findUserById(userId);
  if (!current) throw new AppError('USER_NOT_FOUND', 'Account not found.');

  const previous = kind === 'avatar' ? current.avatarUrl : current.coverUrl;

  await repo.updateImageField(userId, kind === 'avatar' ? 'avatarUrl' : 'coverUrl', null);
  await profileImages.remove(previous, kind);

  await recordAudit(db, {
    action: kind === 'avatar' ? 'user.avatar_removed' : 'user.cover_removed',
    actorUserId: userId,
    targetType: 'user',
    targetId: userId,
    metadata: { kind },
  });

  return getCurrentUser(userId);
}
