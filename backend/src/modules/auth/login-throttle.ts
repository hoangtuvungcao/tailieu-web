import { redis } from '../../db/redis.js';
import { AppError } from '../../lib/errors.js';

/**
 * Per-account login throttling.
 *
 * The route-level rate limit is keyed on `request.ip`, because Fastify runs a
 * route's `keyGenerator` **before the body is parsed** — `request.body` is
 * undefined at that point, so a key written as `login:<ip>:<email>` silently
 * degrades to `login:<ip>:anon` and limits by IP alone.
 *
 * That leaves a real hole: a per-IP limit does nothing against credential
 * stuffing spread across a botnet or a proxy pool, where each attempt reaches
 * the account from a different address. This module closes it by counting
 * failures against the *account*, after the body is available.
 *
 * The counter is incremented for every failed attempt, including attempts
 * against addresses that do not exist. Counting only real accounts would make
 * "am I locked out yet?" an account-enumeration oracle — the lockout itself
 * would reveal which addresses are registered.
 */

/** Failed attempts allowed before the account is temporarily locked. */
const MAX_FAILURES = 10;

/** How long the failure counter lives. Also the lockout duration, since the
 *  lock lifts when the count expires rather than on a separate timer — one
 *  fewer thing to get out of sync. */
const WINDOW_SECONDS = 15 * 60;

function failureKey(email: string): string {
  // Namespaced so it cannot collide with the rate-limit plugin's own keys,
  // which are prefixed `fastify-rate-limit-`.
  return `auth:fail:${email.toLowerCase()}`;
}

export interface ThrottleState {
  failures: number;
  locked: boolean;
  retryAfterSeconds: number;
}

/**
 * Check whether an account is currently locked out.
 *
 * Called BEFORE the password is verified, so a locked account costs one Redis
 * read rather than a 64 MiB Argon2 hash. That ordering matters on a laptop:
 * without it, an attacker can still exhaust the process's memory budget by
 * hammering a locked account.
 */
export async function checkLoginThrottle(email: string): Promise<void> {
  const key = failureKey(email);

  let failures: number;
  let ttl: number;

  try {
    const results = await redis.multi().get(key).ttl(key).exec();
    failures = Number(results?.[0]?.[1] ?? 0);
    ttl = Number(results?.[1]?.[1] ?? 0);
  } catch {
    // Redis unreachable. Fail OPEN here, deliberately: this is a secondary
    // control, and the primary per-IP limit is unaffected. Refusing every
    // login because a cache is down would turn a cache outage into a total
    // outage — a far worse outcome than briefly losing one defence layer.
    return;
  }

  if (failures >= MAX_FAILURES) {
    throw new AppError(
      'RATE_LIMITED',
      'Tài khoản tạm thời bị khoá do đăng nhập sai quá nhiều lần. Vui lòng thử lại sau.',
      { retryAfterSeconds: ttl > 0 ? ttl : WINDOW_SECONDS },
    );
  }
}

/** Record a failed attempt. Returns the new count. */
export async function recordLoginFailure(email: string): Promise<number> {
  const key = failureKey(email);
  try {
    const pipeline = redis.multi().incr(key).expire(key, WINDOW_SECONDS);
    const results = await pipeline.exec();
    return Number(results?.[0]?.[1] ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Clear the counter after a successful sign-in.
 *
 * Without this, a user who mistypes their password nine times over a week and
 * then succeeds would still be one failure away from a lockout — the count
 * would reflect their history rather than their current run.
 */
export async function clearLoginFailures(email: string): Promise<void> {
  try {
    await redis.del(failureKey(email));
  } catch {
    // Best effort. A stale counter expires on its own within the window.
  }
}

/** Current state, for the admin panel and diagnostics. */
export async function inspectThrottle(email: string): Promise<ThrottleState> {
  const key = failureKey(email);
  try {
    const results = await redis.multi().get(key).ttl(key).exec();
    const failures = Number(results?.[0]?.[1] ?? 0);
    const ttl = Number(results?.[1]?.[1] ?? -1);
    return {
      failures,
      locked: failures >= MAX_FAILURES,
      retryAfterSeconds: ttl > 0 ? ttl : 0,
    };
  } catch {
    return { failures: 0, locked: false, retryAfterSeconds: 0 };
  }
}

/** Operator action: release a lockout that was triggered by a mistake. */
export async function resetThrottle(email: string): Promise<void> {
  await redis.del(failureKey(email)).catch(() => undefined);
}
