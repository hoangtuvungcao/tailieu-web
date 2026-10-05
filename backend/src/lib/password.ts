import argon2 from 'argon2';

import { env } from '../config/env.js';

/**
 * Password hashing (Argon2id).
 *
 * Parameters follow OWASP guidance with headroom:
 *   memoryCost 64 MiB, timeCost 3, parallelism 1, 32-byte output.
 *
 * The binding constraint on a laptop is memory x concurrency, not CPU. Each
 * in-flight hash allocates its full 64 MiB, so ten simultaneous logins cost
 * ~640 MiB. That is why login and registration are rate limited at the edge —
 * the rate limit protects the process from being OOM-killed by its own
 * password hashing, not just from credential stuffing.
 *
 * If memory pressure becomes a problem, lower `memoryCost` to 47104 and
 * `timeCost` to 1 rather than weakening the salt or output length — those are
 * the parameters that actually protect against precomputation.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
  /**
   * Application-wide pepper, stored outside the database. Because it is not
   * encoded in the hash string, a stolen database dump alone cannot be
   * attacked offline — the attacker also needs this value. The cost is that
   * losing the pepper invalidates every password, so it must be backed up
   * separately from database backups.
   */
  secret: env.ARGON2_PEPPER ? Buffer.from(env.ARGON2_PEPPER, 'utf8') : undefined,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return argon2.hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify options. The pepper is included only when configured — passing
 * `secret: undefined` explicitly is not the same as omitting it, and argon2
 * treats a present-but-undefined secret inconsistently across versions.
 */
function verifyOptions(): { secret?: Buffer } {
  return ARGON2_OPTIONS.secret ? { secret: ARGON2_OPTIONS.secret } : {};
}

/**
 * Constant-time verification.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt row must
 * produce a failed login, not a 500 that reveals the account exists.
 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext, verifyOptions());
  } catch {
    return false;
  }
}

/**
 * True when a stored hash used weaker parameters than we now require.
 *
 * Call this after a SUCCESSFUL login and transparently rehash. That is the
 * only moment the plaintext is available to us, and it lets the cost parameters
 * be raised over time without forcing a password reset on every user.
 */
export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  } catch {
    // An unparseable hash cannot be verified anyway; a rehash is harmless and
    // will replace it on the next successful login.
    return true;
  }
}

/**
 * Burn the same CPU time as a real verification.
 *
 * Called when a login names an account that does not exist. Without it, a
 * missing account returns in ~1ms while a real one takes ~80ms, and that
 * timing difference is a reliable account-enumeration oracle.
 *
 * The dummy hash is computed lazily on first use rather than at module load:
 * argon2 has no synchronous API, and eagerly hashing would add ~80ms to every
 * process that merely imports this module — including the seed scripts and
 * every unit test.
 */
let dummyHashPromise: Promise<string> | null = null;

function getDummyHash(): Promise<string> {
  dummyHashPromise ??= argon2.hash('dummy-password-for-timing-equalisation', ARGON2_OPTIONS);
  return dummyHashPromise;
}

export async function burnPasswordTime(): Promise<void> {
  try {
    const dummy = await getDummyHash();
    await argon2.verify(dummy, 'never-matches', verifyOptions());
  } catch {
    // Timing equalisation is best-effort; never let it turn a failed login
    // into a 500.
  }
}
