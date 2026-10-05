import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { env, isProduction } from '../config/env.js';
import * as schema from './schema/index.js';

const { Pool, types } = pg;

/**
 * Postgres returns int8 (bigint) as a string to avoid silent precision loss in
 * JavaScript. Every int8 column in this schema is a counter or a byte size —
 * download counts, file sizes, audit log ids — all far below 2^53. Parsing
 * them to numbers keeps arithmetic at call sites from silently becoming string
 * concatenation, which is the classic way a byte-size sum turns into "10242048".
 */
types.setTypeParser(types.builtins.INT8, (value) => Number.parseInt(value, 10));

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  // A laptop's Postgres over a home network is not a low-latency local socket
  // in every deployment, so keep these generous but bounded.
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Never leave a query hanging forever; a stuck query holds a pool slot and
  // eventually starves every other request.
  statement_timeout: 30_000,
  query_timeout: 30_000,
  application_name: 'tailieu-api',
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
});

pool.on('error', (err) => {
  // An idle client erroring is not fatal: pg removes it and the pool creates a
  // replacement. Crashing here would take down the API over a transient
  // network blip. Log loudly instead.
  console.error('[db] idle client error:', err.message);
});

export const db = drizzle(pool, {
  schema,
  casing: 'snake_case',
  // Query logging is opt-in via LOG_LEVEL=trace. It is far too noisy for
  // day-to-day development — a single seed run emits hundreds of statements —
  // and the parameters are redacted anyway, so it has limited debugging value.
  logger:
    env.LOG_LEVEL === 'trace' && !isProduction
      ? {
          logQuery(query) {
            // The statement only, never the parameters: they routinely contain
            // password hashes, token hashes and email addresses.
            console.debug(`[sql] ${query}`);
          },
        }
      : false,
});

export type Database = typeof db;

/** Runs `fn` inside a transaction, rolling back on any thrown error. */
export async function withTransaction<T>(
  fn: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => fn(tx));
}

/** Cheap liveness probe used by /api/health/db. */
export async function pingDatabase(): Promise<{ ok: true; latencyMs: number }> {
  const started = process.hrtime.bigint();
  await pool.query('SELECT 1');
  const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  return { ok: true, latencyMs: Math.round(latencyMs * 100) / 100 };
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
