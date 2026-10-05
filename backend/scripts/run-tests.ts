/**
 * Test runner.
 *
 * Exists because the obvious npm script — `NODE_ENV=test DATABASE_URL=... vitest`
 * — is bash syntax. On Windows, cmd and PowerShell parse the leading
 * assignments as commands and fail with "'NODE_ENV' is not recognized", so the
 * tests simply could not be run on the machine this project deploys to.
 *
 * cross-env fixes the assignment syntax but not `${VAR:-default}`, which is
 * also bash-only. Doing the whole thing in Node removes both problems and keeps
 * the fallback logic in one readable place.
 *
 * Usage:  npm test        (vitest run)
 *         npm run test:watch
 */
import { spawn } from 'node:child_process';

const DEFAULT_TEST_DATABASE_URL =
  'postgres://tailieu:devpassword@localhost:5432/tailieu_test';

/**
 * Resolve the test database URL.
 *
 * `TEST_DATABASE_URL` wins so a CI machine can point somewhere else;
 * `DATABASE_URL` is NOT consulted, deliberately. The test suite deletes users
 * and revokes sessions, and inheriting the development URL by accident would
 * mean running that against real data. The helper in `src/test/helpers.ts`
 * additionally refuses any database whose name does not contain
 * `tailieu_test` — this is the first of two guards, not the only one.
 */
export function resolveTestDatabaseUrl(): string {
  const candidate = process.env.TEST_DATABASE_URL?.trim();
  if (candidate) return candidate;
  return DEFAULT_TEST_DATABASE_URL;
}

const watchMode = process.argv.includes('--watch');

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vitest', ...(watchMode ? [] : ['run']), ...process.argv.slice(2).filter((a) => a !== '--watch')],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: resolveTestDatabaseUrl(),
    },
    // Without this, Ctrl+C on Windows leaves vitest running in the background.
    shell: process.platform === 'win32',
  },
);

child.on('exit', (code) => {
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error('Could not start vitest:', error.message);
  console.error('Run `npm install` first.');
  process.exit(1);
});
