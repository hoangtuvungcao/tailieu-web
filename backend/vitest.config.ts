import { defineConfig } from 'vitest/config';

/**
 * Test configuration.
 *
 * The suite is integration-first. These tests run against a real Postgres and
 * Redis and drive the app through `app.inject()` — Fastify's in-process HTTP
 * harness, so no port is bound.
 *
 * That choice is deliberate. The bugs that actually matter in this codebase
 * live at the seams: a transaction that rolls back the revocation it just
 * wrote, a timestamp that arrives as a string from raw SQL, a cache that
 * disagrees with the database. A unit test with mocked repositories would have
 * passed against every one of them.
 *
 * `fileParallelism: false` because the tests share database state; running
 * files concurrently would have them revoke each other's sessions.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
    fileParallelism: false,
    // Argon2id is intentionally slow (64 MiB, t=3). A test that registers and
    // logs in several times needs real headroom, and a flaky timeout here
    // would be misread as a logic failure.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ['verbose'],
  },
});
