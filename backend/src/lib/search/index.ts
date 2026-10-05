import { PostgresSearchProvider } from './postgres.provider.js';
import type { SearchProvider } from './search.provider.js';

export * from './search.provider.js';
export { PostgresSearchProvider } from './postgres.provider.js';

/**
 * Search provider selection.
 *
 * One switch statement is the entire migration surface. Adding Meilisearch
 * means adding a class that implements `SearchProvider` and a case here —
 * no controller, service or route changes, because none of them know which
 * backend is behind the interface.
 *
 * The Postgres provider remains the default and the fallback. A deployment
 * that has configured an external engine but cannot reach it should still
 * serve searches from the database rather than returning nothing, so provider
 * construction never throws.
 */
let instance: SearchProvider | null = null;

export function getSearchProvider(): SearchProvider {
  if (instance) return instance;

  // When an external provider is added:
  //   case 'meilisearch': instance = new MeilisearchProvider(...); break;
  //                       with a try/catch falling back to Postgres.
  instance = new PostgresSearchProvider();
  return instance;
}

/** Test hook. */
export function setSearchProvider(provider: SearchProvider | null): void {
  instance = provider;
}

/** Names of the fields a query is matched against, for the API's own docs. */
export const SEARCHABLE_FIELDS = [
  'title',
  'description',
  'tags',
  'faculty',
  'program',
  'subject',
  'course',
  'documentType',
  'academicYear',
] as const;
