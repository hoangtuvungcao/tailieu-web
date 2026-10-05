/**
 * Create and prepare the test database.
 *
 * Cross-platform replacement for the previous `docker exec ... createdb`
 * one-liner, which only worked on a machine with Docker. The server this
 * project deploys to runs Windows Server 2012 R2, where Docker is not
 * available at all — so the setup step has to work through plain PostgreSQL
 * client tools.
 *
 * Requires `psql` and `createdb` on PATH (they ship with the PostgreSQL
 * installer on Windows and with `postgresql-client` on Debian).
 *
 * Usage:  npm run test:setup
 */
import { spawnSync } from 'node:child_process';

import { resolveTestDatabaseUrl } from './run-tests.js';

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): boolean {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  });
  return result.status === 0;
}

function main(): void {
  const url = new URL(resolveTestDatabaseUrl());
  const database = url.pathname.replace(/^\//, '');

  if (!database.includes('tailieu_test')) {
    console.error(
      `Refusing to set up "${database}": the name must contain "tailieu_test".\n` +
        'This script DROPS the database it targets.',
    );
    process.exit(1);
  }

  console.log(`\nPreparing test database "${database}"\n`);

  // Connect to the maintenance database to drop and recreate, because you
  // cannot drop the database you are connected to.
  const maintenanceUrl = new URL(url.toString());
  maintenanceUrl.pathname = '/postgres';

  console.log('  → dropping and recreating ...');
  const dropped = run('psql', [
    maintenanceUrl.toString(),
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `DROP DATABASE IF EXISTS ${database};`,
    '-c',
    `CREATE DATABASE ${database};`,
  ]);

  if (!dropped) {
    console.error(
      '\nCould not reach PostgreSQL.\n' +
        '  - Is the server running?\n' +
        '  - Do psql/createdb exist on PATH?\n' +
        `  - Is the URL correct? (${maintenanceUrl.host})\n`,
    );
    process.exit(1);
  }

  // Migrations run as part of setup. Without this a schema change makes the
  // test database stale, and the failure appears as a 500 in whichever test
  // happens to touch the new column first — a confusing place to look.
  console.log('  → applying migrations ...');
  if (!run('npx', ['tsx', 'src/db/migrate.ts'], { NODE_ENV: 'test', DATABASE_URL: url.toString() })) {
    process.exit(1);
  }

  console.log('  → seeding ...');
  if (!run('npx', ['tsx', 'src/db/seed.ts'], { NODE_ENV: 'test', DATABASE_URL: url.toString() })) {
    process.exit(1);
  }

  console.log('\nTest database ready. Run `npm test`.\n');
}

main();
