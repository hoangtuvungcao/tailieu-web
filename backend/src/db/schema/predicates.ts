import { sql, type SQL } from 'drizzle-orm';

/**
 * Shared SQL predicates.
 *
 * These exist so that the predicate in a partial index definition and the
 * predicate in the query that is supposed to use that index are *literally the
 * same object*. Postgres only uses a partial index when it can prove the query
 * predicate implies the index predicate; a cosmetic difference — say
 * `status = 'published'` written as `status IN ('published')`, or columns
 * ordered differently — silently degrades an indexed lookup into a sequential
 * scan. Sharing one constant makes that class of bug impossible to introduce
 * by accident.
 */

/** The visibility rule for anything a normal visitor may see. */
export const publishedDocument: SQL = sql`deleted_at IS NULL AND status = 'published' AND visibility <> 'private'`;

/** Ready-to-serve files only. A file still assembling must not be downloadable. */
export const readyFile: SQL = sql`deleted_at IS NULL AND status = 'ready'`;

/** Taxonomy rows that are neither deleted nor deactivated. */
export const activeTaxonomy: SQL = sql`deleted_at IS NULL AND is_active`;

/** Unrevoked, unexpired sessions. */
export const liveSession: SQL = sql`revoked_at IS NULL AND expires_at > now()`;
