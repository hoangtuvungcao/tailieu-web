import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque token generation and hashing.
 *
 * Refresh tokens, email-verification tokens and password-reset tokens are all
 * opaque random strings, never JWTs. A JWT here would be self-describing and
 * self-validating, which is exactly wrong: we need the server to be able to
 * revoke a token, and we need a database lookup on every use so that reuse of
 * a rotated token is detectable.
 *
 * Only the hash is stored. A database leak therefore does not hand the attacker
 * usable session tokens — the same reasoning that applies to passwords applies
 * to bearer tokens, and it is skipped just as often.
 */

/** Distinguishes token types in logs and makes an accidental cross-use obvious. */
const REFRESH_PREFIX = 'rt';
const EMAIL_PREFIX = 'ev';
const RESET_PREFIX = 'pr';

/**
 * 32 bytes = 256 bits of entropy. Well beyond brute-force range, and short
 * enough that the cookie stays comfortably inside header limits.
 */
const TOKEN_BYTES = 32;

export interface GeneratedToken {
  /** The value handed to the client. Never stored, never logged. */
  raw: string;
  /** sha256(raw), which is what goes in the database. */
  hash: Buffer;
}

function generate(prefix: string): GeneratedToken {
  const raw = `${prefix}_${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  return { raw, hash: hashToken(raw) };
}

export const generateRefreshToken = (): GeneratedToken => generate(REFRESH_PREFIX);
export const generateEmailVerificationToken = (): GeneratedToken => generate(EMAIL_PREFIX);
export const generatePasswordResetToken = (): GeneratedToken => generate(RESET_PREFIX);

export function hashToken(raw: string): Buffer {
  return createHash('sha256').update(raw, 'utf8').digest();
}

/**
 * Compare two token hashes without leaking position information through timing.
 *
 * Node's `timingSafeEqual` throws on length mismatch, so the length check comes
 * first — a length difference is not secret, since every hash is 32 bytes.
 */
export function tokenHashEquals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * CSRF token for the double-submit pattern.
 *
 * A random value is placed in a readable cookie and must be echoed back in a
 * header. A cross-site attacker can cause the browser to send the cookie but
 * cannot read it to populate the header, so the forged request fails.
 */
export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time comparison of two CSRF strings. */
export function csrfTokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Which token prefix a value carries, if any.
 *
 * Used to reject a password-reset token presented at the refresh endpoint
 * before it ever reaches a database query.
 */
export function tokenPrefix(raw: string): string | null {
  const index = raw.indexOf('_');
  return index === -1 ? null : raw.slice(0, index);
}
