import { afterEach, describe, expect, it } from 'vitest';

import { redis } from '../../db/redis.js';
import { assertTestDatabase } from '../../test/helpers.js';
import {
  checkLoginThrottle,
  clearLoginFailures,
  inspectThrottle,
  recordLoginFailure,
  resetThrottle,
} from './login-throttle.js';

/**
 * Per-account login throttling.
 *
 * These tests exist because the route-level rate limit does NOT do what its
 * code implies. Fastify runs a route's `keyGenerator` before the body is
 * parsed, so `login:<ip>:<email>` silently becomes `login:<ip>:anon` — the
 * email is never available. That leaves the limit keyed on IP alone, which
 * does nothing against credential stuffing spread across many addresses.
 *
 * The account-scoped counter below is the control that actually closes it.
 */

assertTestDatabase();

const TEST_EMAIL = 'throttle-probe@tailieu.test';

afterEach(async () => {
  await resetThrottle(TEST_EMAIL);
});


describe('login throttle', () => {
  it('allows sign-in while under the failure threshold', async () => {
    for (let i = 0; i < 9; i += 1) {
      await recordLoginFailure(TEST_EMAIL);
    }

    // Nine failures is a fat-fingered password, not an attack.
    await expect(checkLoginThrottle(TEST_EMAIL)).resolves.toBeUndefined();
  });

  it('locks the account at the threshold', async () => {
    for (let i = 0; i < 10; i += 1) {
      await recordLoginFailure(TEST_EMAIL);
    }

    await expect(checkLoginThrottle(TEST_EMAIL)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('reports a retry hint so a client knows when to come back', async () => {
    for (let i = 0; i < 10; i += 1) {
      await recordLoginFailure(TEST_EMAIL);
    }

    const state = await inspectThrottle(TEST_EMAIL);
    expect(state.locked).toBe(true);
    expect(state.failures).toBe(10);
    // Without this the client can only guess, and a client that guesses retries
    // into a still-locked account.
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('is scoped per account, not global', async () => {
    // THE property that makes this worth having. If one account's failures
    // locked everyone, an attacker could deny service to the whole university
    // by failing ten times against a single address.
    for (let i = 0; i < 10; i += 1) {
      await recordLoginFailure(TEST_EMAIL);
    }

    await expect(checkLoginThrottle(TEST_EMAIL)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(checkLoginThrottle('someone-else@tailieu.test')).resolves.toBeUndefined();
  });

  it('is case-insensitive on the address', async () => {
    // Otherwise an attacker doubles their budget by changing capitalisation,
    // and a user who capitalises differently is not recognised as locked out.
    for (let i = 0; i < 10; i += 1) {
      await recordLoginFailure(TEST_EMAIL.toUpperCase());
    }

    await expect(checkLoginThrottle(TEST_EMAIL)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('clears the streak after a successful sign-in', async () => {
    await recordLoginFailure(TEST_EMAIL);
    await recordLoginFailure(TEST_EMAIL);
    expect((await inspectThrottle(TEST_EMAIL)).failures).toBe(2);

    await clearLoginFailures(TEST_EMAIL);

    // Without this a user who mistyped nine times over a week and then
    // succeeded would still be one slip away from a lockout.
    expect((await inspectThrottle(TEST_EMAIL)).failures).toBe(0);
    await expect(checkLoginThrottle(TEST_EMAIL)).resolves.toBeUndefined();
  });

  it('lets an operator release a lockout', async () => {
    for (let i = 0; i < 10; i += 1) {
      await recordLoginFailure(TEST_EMAIL);
    }

    await resetThrottle(TEST_EMAIL);

    await expect(checkLoginThrottle(TEST_EMAIL)).resolves.toBeUndefined();
  });

  it('sets an expiry, so a lockout is not permanent', async () => {
    await recordLoginFailure(TEST_EMAIL);

    const keys = await redis.keys(`auth:fail:${TEST_EMAIL}`);
    expect(keys).toHaveLength(1);

    const ttl = await redis.ttl(keys[0]!);
    // A locked account must unlock on its own. An expiry of -1 would mean the
    // lock never lifts and the user is permanently shut out.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15 * 60);
  });

  it('does not count successes toward the failure streak', async () => {
    await recordLoginFailure(TEST_EMAIL);
    await clearLoginFailures(TEST_EMAIL);
    await recordLoginFailure(TEST_EMAIL);

    // One failure after a success, not two.
    expect((await inspectThrottle(TEST_EMAIL)).failures).toBe(1);
  });
});

// Closing the shared client is deliberately NOT done here: other suites in the
// same run use the same connection, and closing it mid-run makes them fail with
// "Connection is closed" for reasons unrelated to what they test.
