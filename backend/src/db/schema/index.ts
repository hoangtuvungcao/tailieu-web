/**
 * Drizzle schema barrel.
 *
 * `drizzle.config.ts` points here, so every table file must be re-exported for
 * migrations to see it. Omitting one silently produces a migration that drops
 * the missing table, so this file is the single place to check when a table
 * "disappears" from a generated migration.
 */

export * from './custom-types.js';
export * from './enums.js';
export * from './predicates.js';

export * from './taxonomy.js';
export * from './identity.js';
export * from './rbac.js';
export * from './documents.js';
export * from './uploads.js';
export * from './settings.js';
export * from './reports.js';

// Social tables live under social/ to keep this directory navigable.
export * from './social/enums.js';
export * from './social/content.js';
export * from './social/engagement.js';
export * from './social/graph.js';
