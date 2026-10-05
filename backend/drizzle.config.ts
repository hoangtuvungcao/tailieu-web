import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration.
 *
 * Migrations are generated as plain SQL into ./drizzle and applied by
 * `src/db/migrate.ts`. We never use `drizzle-kit push` outside local
 * experimentation: push diffs the live schema and can silently drop columns,
 * which on a database holding real student documents is a data-loss event.
 */
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://tailieu:tailieu@localhost:5432/tailieu',
  },
  verbose: true,
  strict: true,
  // Keep generated SQL readable in review — this schema relies on partial
  // indexes and expression indexes that a human needs to be able to audit.
  casing: 'snake_case',
});
