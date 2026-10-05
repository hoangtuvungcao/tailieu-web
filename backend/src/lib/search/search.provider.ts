import type { FileKind } from '../files/mime.js';
import type { DocumentDto } from '../../modules/documents/documents.mapper.js';

/**
 * Search abstraction.
 *
 * Everything that searches goes through this interface, never through
 * Postgres directly. That is the whole point: §10 requires the search
 * architecture to be migratable to Meilisearch, OpenSearch or Elasticsearch
 * without rewriting the application.
 *
 * The seam only holds if it is respected. The moment a controller builds its
 * own `ILIKE` query, or a service reaches for `documents.tsv`, the migration
 * stops being a swap and becomes a rewrite — because the ranking semantics,
 * the filter vocabulary and the pagination contract are now defined in the
 * call site rather than here.
 *
 * What the interface deliberately exposes, because these are the things a
 * future backend cannot infer:
 *   - the full filter vocabulary, as a typed object rather than raw SQL
 *   - the sort modes, as an enum rather than an ORDER BY fragment
 *   - the result shape, including `highlight` and `score`
 *
 * What it deliberately hides:
 *   - how matching works (tsvector, trigram, BM25, inverted index)
 *   - how ranking works
 *   - whether the index is a column or a separate service
 */

export type SearchSort =
  | 'relevance'
  | 'newest'
  | 'oldest'
  | 'popular'
  | 'rated'
  | 'title';

export interface SearchFilters {
  facultyId?: string;
  programId?: string;
  subjectId?: string;
  courseId?: string;
  academicYearId?: string;
  semesterId?: string;
  documentTypeId?: string;
  fileKind?: FileKind;
  tag?: string;
  ownerUserId?: string;
  /** Inclusive lower bound on the publication date. */
  publishedAfter?: string;
  publishedBefore?: string;
  minRating?: number;
}

export interface SearchRequest {
  /** Free-text query. Empty means "browse", which is a valid search. */
  query: string;
  filters: SearchFilters;
  sort: SearchSort;
  page: number;
  limit: number;
  /** Who is asking. The provider is responsible for visibility, not the caller. */
  viewer: {
    userId: string | null;
    isModerator: boolean;
    facultyIds: string[];
  };
  /** When false, only metadata is returned — no file lists or tag joins. */
  includeRelations?: boolean;
}

export interface SearchHighlight {
  field: 'title' | 'description';
  /** Text with matched terms wrapped in the configured markers. */
  value: string;
}

export interface SearchHit {
  document: DocumentDto;
  /**
   * Backend-specific relevance. Comparable only within one result set — the
   * scale differs entirely between Postgres `ts_rank_cd` and Meilisearch's
   * BM25, so nothing may persist or compare scores across backends.
   */
  score: number | null;
  highlights: SearchHighlight[];
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  /** Server-side duration, surfaced so slow queries are visible in the UI. */
  tookMs: number;
  /** Which backend answered, for diagnostics during a migration. */
  provider: string;
}

export type SuggestionKind = 'faculty' | 'program' | 'subject' | 'tag' | 'document';

export interface SearchSuggestion {
  kind: SuggestionKind;
  id: string;
  label: string;
  /** Secondary line, e.g. the faculty a program belongs to. */
  hint: string | null;
  /** Client-side route to navigate to. */
  href: string;
}

export interface SearchProvider {
  readonly name: string;

  /** Execute a search. Must apply visibility; must never return hidden rows. */
  search(request: SearchRequest): Promise<SearchResult>;

  /** Typeahead suggestions for a partial query. */
  suggest(prefix: string, limit: number): Promise<SearchSuggestion[]>;

  /**
   * Rebuild derived index state for one document.
   *
   * A no-op for Postgres, where the index is a generated column maintained by
   * triggers. It exists because Meilisearch and friends need an explicit
   * upsert, and retrofitting this method later would mean touching every write
   * path in the application.
   */
  indexDocument(documentId: string): Promise<void>;

  /** Remove a document from the index. */
  removeDocument(documentId: string): Promise<void>;

  /** Backend reachability, for the health endpoint and the admin panel. */
  health(): Promise<{ ok: boolean; detail?: string }>;
}

/**
 * Markers used to wrap matched terms in `highlight` values.
 *
 * Chosen as characters that cannot appear in the source text, so wrapping is
 * unambiguous and the client can split on them without escaping. The frontend
 * renders the segments as elements — never as HTML, which would turn a
 * document titled "<script>" into stored XSS.
 */
export const HIGHLIGHT_START = '\u0002';
export const HIGHLIGHT_END = '\u0003';
