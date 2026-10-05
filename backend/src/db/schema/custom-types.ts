import { customType } from 'drizzle-orm/pg-core';

/**
 * Postgres types Drizzle does not model natively.
 *
 * These are thin wrappers: they change only how Drizzle types the value in
 * TypeScript and which SQL type it emits. No runtime conversion happens, so a
 * `bytea` column arrives as a Node Buffer and a `citext` as a string.
 */

/** Case-insensitive text — used for email and slugs. Requires the citext extension. */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

/**
 * Raw bytes. Used for token hashes: refresh and verification tokens are stored
 * as `sha256(raw)`, never as the raw value, so a database leak does not hand
 * an attacker usable session tokens.
 */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * Full-text search vector. Declared so queries can reference `documents.tsv`
 * with proper typing; the column itself is a STORED generated column created
 * in the migration, not written by application code.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

/** IPv4/IPv6 address. Stored as `inet` so Postgres can validate and index it. */
export const inet = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'inet';
  },
});
