import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, apiWithMeta } from './api-client';

/**
 * Query hooks.
 *
 * Server state lives here and nowhere else. Every hook keys on the exact inputs
 * it depends on, so a filter change produces a distinct cache entry rather than
 * a stale list — the single most common bug in hand-rolled data fetching.
 */

// --- Types -------------------------------------------------------------------

export interface TaxonomyRef {
  id: string;
  name: string;
  code: string;
}

export interface DocumentFile {
  id: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string;
  fileKind: string;
  isPrimary: boolean;
  status: string;
  extension: string | null;
  pageCount: number | null;
  previewStatus: string;
  downloadUrl: string;
}

export interface DocumentSummary {
  id: string;
  slug: string | null;
  title: string;
  description: string | null;
  status: string;
  visibility: string;
  language: string;
  fileKind: string | null;
  sizeBytes: number | null;
  pageCount: number | null;
  owner: { id: string; displayName: string; avatarUrl: string | null } | null;
  taxonomy: {
    faculty: TaxonomyRef | null;
    program: TaxonomyRef | null;
    subject: TaxonomyRef | null;
    course: { id: string; name: string | null; code: string } | null;
    documentType: TaxonomyRef | null;
    academicYear: { id: string; code: string; name: string } | null;
    semester: { id: string; code: string; name: string } | null;
  };
  tags: { id: string; slug: string; name: string }[];
  files: DocumentFile[];
  stats: {
    downloads: number;
    views: number;
    likes: number;
    comments: number;
    ratingCount: number;
    ratingAverage: number | null;
  };
  copyright: { license: string | null; status: string; source: string | null; attribution: string | null };
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  permissions?: {
    canEdit: boolean;
    canDelete: boolean;
    canModerate: boolean;
    canDownload: boolean;
  };
}

export interface SearchHit {
  document: DocumentSummary;
  score: number | null;
  highlights: { field: string; value: string }[];
}

export interface Faculty {
  id: string;
  code: string;
  name: string;
  shortName: string | null;
  icon: string | null;
  sortOrder: number;
}

export interface PaginatedMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext?: boolean;
  hasPrev?: boolean;
}

export interface DocumentFilters {
  q?: string;
  facultyId?: string;
  programId?: string;
  subjectId?: string;
  documentTypeId?: string;
  academicYearId?: string;
  fileKind?: string;
  tag?: string;
  sort?: string;
  page?: number;
  limit?: number;
}

function toQueryString(filters: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

// --- Documents ---------------------------------------------------------------

export function useDocuments(filters: DocumentFilters) {
  return useQuery({
    // The filters object is part of the key, so each distinct filter
    // combination caches separately and pagination does not overwrite page 1.
    queryKey: ['documents', filters],
    queryFn: async () => {
      const { data, meta } = await apiWithMeta<DocumentSummary[]>(
        `/documents${toQueryString({ ...filters })}`,
      );
      return { documents: data, meta: meta as unknown as PaginatedMeta };
    },
  });
}

export function useDocument(id: string | undefined) {
  return useQuery({
    queryKey: ['document', id],
    queryFn: () => api.get<DocumentSummary>(`/documents/${id}`),
    enabled: Boolean(id),
  });
}

export function useSearch(query: string, filters: DocumentFilters = {}) {
  return useQuery({
    queryKey: ['search', query, filters],
    queryFn: async () => {
      const { data, meta } = await apiWithMeta<SearchHit[]>(
        `/search${toQueryString({ q: query, ...filters })}`,
      );
      return { hits: data, meta: meta as unknown as PaginatedMeta & { tookMs: number; provider: string } };
    },
    enabled: query.trim().length > 0,
  });
}

export function useSuggestions(prefix: string) {
  return useQuery({
    queryKey: ['suggest', prefix],
    queryFn: () =>
      api.get<{ kind: string; id: string; label: string; hint: string | null; href: string }[]>(
        `/search/suggest${toQueryString({ q: prefix })}`,
      ),
    enabled: prefix.trim().length >= 2,
    // Suggestions are cheap to recompute and go stale fast as the user types.
    staleTime: 10_000,
  });
}

// --- Taxonomy ----------------------------------------------------------------

export function useFaculties() {
  return useQuery({
    queryKey: ['faculties'],
    queryFn: async () => {
      const { data } = await apiWithMeta<Faculty[]>('/taxonomy/faculties?limit=100');
      return data;
    },
    // Reference data changes rarely; caching it avoids re-fetching on every
    // page that renders a faculty filter.
    staleTime: 10 * 60_000,
  });
}

export function usePrograms(facultyId?: string) {
  return useQuery({
    queryKey: ['programs', facultyId],
    queryFn: async () => {
      const { data } = await apiWithMeta<Faculty[]>(
        `/taxonomy/programs${toQueryString({ facultyId, limit: 100 })}`,
      );
      return data;
    },
    enabled: Boolean(facultyId),
    staleTime: 10 * 60_000,
  });
}

export function useDocumentTypes() {
  return useQuery({
    queryKey: ['document-types'],
    queryFn: async () => {
      const { data } = await apiWithMeta<{ id: string; code: string; name: string }[]>(
        '/taxonomy/document-types?limit=100',
      );
      return data;
    },
    staleTime: 10 * 60_000,
  });
}

// --- Mutations ---------------------------------------------------------------

/**
 * Download a document.
 *
 * The API returns a short-lived signed URL rather than the file, so the browser
 * must be sent to it. A hidden anchor click is used instead of
 * `window.location =` because the latter would navigate the SPA away from the
 * current page and lose all state.
 */
export function useDownloadDocument() {
  return useMutation({
    mutationFn: async (documentId: string) =>
      api.get<{ url: string; fileName: string; mimeType: string }>(
        `/documents/${documentId}/download`,
      ),
    onSuccess: (data) => {
      const anchor = document.createElement('a');
      anchor.href = data.url;
      anchor.download = data.fileName;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    },
  });
}

export function useRateDocument() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { documentId: string; rating: number; review?: string }) =>
      api.post<{ ratingAverage: number | null; ratingCount: number }>(
        `/documents/${input.documentId}/ratings`,
        { rating: input.rating, review: input.review ?? null },
      ),
    onSuccess: (_result, variables) => {
      // Invalidate rather than write the response into the cache: the average
      // depends on every other rating, and a local patch would drift.
      void queryClient.invalidateQueries({ queryKey: ['document', variables.documentId] });
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
  });
}

export function useDeleteDocument() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (documentId: string) => api.delete(`/documents/${documentId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
  });
}
