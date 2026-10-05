/**
 * Migration runner.
 *
 * Order is load-bearing:
 *   1. pre.sql   — extensions and immutable_unaccent. Must precede generated
 *                  migrations, which create GIN/trigram indexes that need them.
 *   2. generated — Drizzle's SQL, applied in journal order, forward only.
 *   3. post.sql  — triggers, cross-table search maintenance, CHECK constraints.
 *                  Must follow the generated migrations, because every
 *                  statement references tables that only exist afterwards.
 *
 * Run with: npm run db:migrate
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { closeDatabase, db, pool } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * SQL files live next to the TypeScript source in development but must be
 * copied into `dist` for a production build. Resolve whichever exists rather
 * than hard-coding one layout.
 */
function resolveSqlDir(): string {
  const candidates = [
    path.join(here, 'sql'), // dist/db/sql after the build copy step
    path.join(here, '..', '..', 'src', 'db', 'sql'), // running from dist without the copy
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'pre.sql'))) return candidate;
  }
  throw new Error(
    `Could not locate SQL bootstrap files. Looked in:\n  ${candidates.join('\n  ')}\n` +
      'Run `npm run build` (which copies them) or run migrations from the source tree.',
  );
}

function resolveMigrationsDir(): string {
  const candidates = [
    path.join(here, '..', '..', 'drizzle'), // dist/db -> backend/drizzle
    path.join(here, '..', '..', '..', 'drizzle'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not locate the drizzle migrations directory. Looked in:\n  ${candidates.join('\n  ')}`);
}

async function runSqlFile(filePath: string, label: string): Promise<void> {
  const sqlText = await readFile(filePath, 'utf8');
  if (!sqlText.trim()) return;
  process.stdout.write(`  → ${label} ... `);
  const client = await pool.connect();
  try {
    await client.query(sqlText);
    process.stdout.write('ok\n');
  } catch (error) {
    process.stdout.write('FAILED\n');
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const sqlDir = resolveSqlDir();
  const migrationsDir = resolveMigrationsDir();

  console.log('Running migrations\n');
  console.log(`  source:     ${sqlDir}`);
  console.log(`  migrations: ${migrationsDir}\n`);

  await runSqlFile(path.join(sqlDir, 'pre.sql'), 'pre.sql (extensions, immutable_unaccent)');

  process.stdout.write('  → drizzle migrations ... ');
  try {
    await migrate(db, { migrationsFolder: migrationsDir });
    process.stdout.write('ok\n');
  } catch (error) {
    process.stdout.write('FAILED\n');
    throw error;
  }

  await runSqlFile(path.join(sqlDir, 'post.sql'), 'post.sql (triggers, check constraints)');

  // Verify the search machinery actually works rather than assuming the
  // statements above did what they claim. A silently missing trigger produces
  // a search index that is empty for every new document, which is invisible
  // until users start complaining that nothing is findable.
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname IN (
          'documents_search_text_trg',
          'document_tags_search_text_trg',
          'tags_search_text_trg'
        )`,
  );
  const triggerCount = Number(rows[0]?.count ?? 0);
  if (triggerCount < 3) {
    throw new Error(
      `Expected 3 search-maintenance triggers, found ${triggerCount}. ` +
        'Search would silently return nothing for new documents.',
    );
  }

  const { rows: fnRows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_proc
      WHERE proname IN ('immutable_unaccent', 'compute_document_search_text')`,
  );
  if (Number(fnRows[0]?.count ?? 0) < 2) {
    throw new Error('immutable_unaccent or compute_document_search_text is missing after migration.');
  }

  console.log('\nMigrations complete. Search functions and triggers verified.');
}

main()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error('\nMigration failed:\n');
    console.error(error);
    await closeDatabase().catch(() => undefined);
    process.exit(1);
  });
