import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, apiWithMeta } from './api-client';
import type { DocumentSummary } from './hooks';

/**
 * Admin data hooks.
 *
 * Keyed per filter combination so paging and filtering do not overwrite one
 * another, and mutations invalidate the specific queries they affect rather
 * than clearing the whole cache — an administrator editing one user should not
 * lose their place in the audit log.
 */

// --- Types -------------------------------------------------------------------

export interface PlatformStats {
  users: { total: number; active30d: number; newToday: number; new7d: number; suspended: number };
  documents: {
    total: number;
    published: number;
    pendingReview: number;
    deleted: number;
    downloads: number;
  };
  storage: { objects: number; bytes: number; orphaned: number; shared: number };
  moderation: { openReports: number; pendingDocuments: number };
  uploads: { inProgress: number };
}

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  status: 'active' | 'suspended' | 'deactivated';
  emailVerified: boolean;
  primaryFacultyId: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  roleKeys: string[];
}

export interface AdminUserDetail extends Omit<AdminUser, 'emailVerified' | 'roleKeys'> {
  fullName: string | null;
  emailVerifiedAt: string | null;
  tokenVersion: number;
  activeSessions: number;
  roles: {
    id: string;
    roleId: string;
    roleKey: string;
    roleName: string;
    facultyId: string | null;
    grantedAt: string;
  }[];
  sessions: {
    id: string;
    userAgent: string | null;
    ip: string | null;
    lastUsedAt: string;
    expiresAt: string;
    revokedReason: string | null;
    active: boolean;
  }[];
  usage: { usedBytes: number; documentCount: number; quotaBytes: number | null };
}

export interface AdminReport {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  details: string | null;
  status: 'pending' | 'reviewing' | 'resolved' | 'rejected';
  createdAt: string;
  reporterName: string;
  reporterEmail: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export interface AuditEntry {
  id: number;
  action: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorName: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface SettingEntry {
  key: string;
  value: unknown;
  category: string;
  description: string | null;
  updatedAt: string;
}

export interface PaginatedMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

function qs(filters: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

// --- Dashboard ---------------------------------------------------------------

export function useAdminStats() {
  return useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: () => api.get<PlatformStats>('/admin/stats'),
    // Short staleness: an operator watching a situation wants numbers that move.
    staleTime: 15_000,
  });
}

export function useTimeseries(metric: 'users' | 'documents' | 'downloads' | 'uploads', days: number) {
  return useQuery({
    queryKey: ['admin', 'timeseries', metric, days],
    queryFn: () =>
      api.get<{ date: string; value: number }[]>(`/admin/stats/timeseries${qs({ metric, days })}`),
    staleTime: 60_000,
  });
}

// --- Users -------------------------------------------------------------------

export function useAdminUsers(filters: {
  q?: string;
  status?: string;
  role?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery({
    queryKey: ['admin', 'users', filters],
    queryFn: async () => {
      const { data, meta } = await apiWithMeta<AdminUser[]>(`/admin/users${qs(filters)}`);
      return { users: data, meta: meta as unknown as PaginatedMeta };
    },
  });
}

export function useAdminUser(id: string | undefined) {
  return useQuery({
    queryKey: ['admin', 'user', id],
    queryFn: () => api.get<AdminUserDetail>(`/admin/users/${id}`),
    enabled: Boolean(id),
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; status?: string; displayName?: string; reason?: string }) =>
      api.patch(`/admin/users/${input.id}`, {
        ...(input.status ? { status: input.status } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      }),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'user', variables.id] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
      // Suspending a user changes the session and user counts on the dashboard.
      void queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] });
    },
  });
}

export function useGrantRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; roleKey: string; facultyId?: string | null }) =>
      api.post(`/admin/users/${input.id}/roles`, {
        roleKey: input.roleKey,
        facultyId: input.facultyId ?? null,
      }),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'user', variables.id] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });
}

export function useRevokeRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; roleId: string }) =>
      api.delete(`/admin/users/${input.id}/roles/${input.roleId}`),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'user', variables.id] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });
}

export function useForceLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/admin/users/${id}/force-logout`),
    onSuccess: (_result, id) => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'user', id] });
    },
  });
}

export function useRoles() {
  return useQuery({
    queryKey: ['admin', 'roles'],
    queryFn: () => api.get<{ id: string; key: string; name: string; rank: number }[]>('/admin/roles'),
    staleTime: 10 * 60_000,
  });
}

// --- Reports -----------------------------------------------------------------

export function useAdminReports(filters: { status?: string; page?: number; limit?: number }) {
  return useQuery({
    queryKey: ['admin', 'reports', filters],
    queryFn: async () => {
      const { data, meta } = await apiWithMeta<AdminReport[]>(`/admin/reports${qs(filters)}`);
      return { reports: data, meta: meta as unknown as PaginatedMeta };
    },
  });
}

export function useResolveReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; status: 'resolved' | 'rejected' | 'reviewing'; note?: string }) =>
      api.post(`/admin/reports/${input.id}/resolve`, {
        status: input.status,
        note: input.note ?? null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'reports'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] });
    },
  });
}

// --- Moderation queue --------------------------------------------------------

/**
 * Documents waiting for a decision.
 *
 * The dashboard has always reported how many are stuck in `pending_review`,
 * and until this existed there was no screen anywhere that could move one. A
 * number on a dashboard that nobody can act on is worse than no number.
 *
 * The list is the ordinary `DocumentSummary`, so a moderator sees the same
 * title, owner, faculty and type the submitter does.
 */
export function useAdminDocuments(filters: {
  status?: string;
  facultyId?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery({
    queryKey: ['admin', 'documents', filters],
    queryFn: async () => {
      const { data, meta } = await apiWithMeta<DocumentSummary[]>(
        `/documents/moderation/queue${qs(filters)}`,
      );
      return { documents: data, meta: meta as unknown as PaginatedMeta };
    },
  });
}

export function useModerateDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      action: 'publish' | 'reject' | 'archive' | 'restore';
      reason?: string | null;
    }) =>
      api.post(`/documents/${input.id}/moderate`, {
        action: input.action,
        reason: input.reason || null,
      }),
    onSuccess: () => {
      // Both, because the decision changes the queue the moderator is looking
      // at and the pending count on the dashboard behind it.
      void queryClient.invalidateQueries({ queryKey: ['admin', 'documents'] });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'stats'] });
    },
  });
}

// --- Audit -------------------------------------------------------------------

export function useAuditLog(filters: {
  action?: string;
  targetType?: string;
  actorUserId?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery({
    queryKey: ['admin', 'audit', filters],
    queryFn: async () => {
      const { data, meta } = await apiWithMeta<AuditEntry[]>(`/admin/audit-logs${qs(filters)}`);
      return { entries: data, meta: meta as unknown as PaginatedMeta };
    },
  });
}

// --- Storage -----------------------------------------------------------------

export interface StorageOverview {
  objects: number;
  bytes: number;
  orphaned: number;
  shared: number;
  liveBytes: number;
  /**
   * Files by scan state. Sparse — a state with no files is absent entirely, so
   * every read has to cope with `undefined` rather than assume a zero.
   *
   * `pending` is the one that matters operationally: a pending file is not
   * downloadable, so a count that never falls means the scanner is not running.
   */
  scan: Record<string, number>;
  largest: { objectKey: string; sizeBytes: number; mimeType: string; refCount: number }[];
  orphans: { objectKey: string; sizeBytes: number; createdAt: string }[];
}

export function useStorageOverview() {
  return useQuery({
    queryKey: ['admin', 'storage'],
    queryFn: () => api.get<StorageOverview>('/admin/storage'),
    staleTime: 30_000,
  });
}

// --- Settings ----------------------------------------------------------------

export function useAdminSettings() {
  return useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () =>
      api.get<{ entries: SettingEntry[]; grouped: Record<string, SettingEntry[]> }>(
        '/admin/settings',
      ),
    staleTime: 60_000,
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (values: Record<string, unknown>) => api.patch('/admin/settings', { values }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
    },
  });
}

// --- Taxonomy ----------------------------------------------------------------

/**
 * The entities the taxonomy admin screen manages.
 *
 * One generic hook set rather than seven bespoke ones. Each is the same shape —
 * a list, a create, an update, a delete, gated by a different permission — so
 * seven copies would be seven places to fix the same bug, and the differences
 * that matter (which fields exist, which permission applies) are data, below in
 * `TAXONOMY_ENTITIES`.
 */
export type TaxonomyEntity =
  | 'faculties'
  | 'programs'
  | 'subjects'
  | 'courses'
  | 'academic-years'
  | 'semesters'
  | 'document-types';

function invalidateTaxonomy(queryClient: ReturnType<typeof useQueryClient>, entity: TaxonomyEntity) {
  void queryClient.invalidateQueries({ queryKey: ['admin', 'taxonomy', entity] });

  // The public reference-data caches too. These feed every faculty and document
  // type filter in the application, so an administrator renaming a faculty and
  // then seeing the old name in the document filters would look like the edit
  // had failed. `['programs']` is a prefix match and clears the per-faculty
  // lists as well.
  for (const key of ['faculties', 'programs', 'document-types']) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}

/**
 * `limit=100` is the API's maximum page size — asking for more is a 422, not a
 * larger page, so this is the ceiling rather than a preference.
 *
 * The total comes back with the items so the screen can say when there are more
 * rows than it is showing. Displaying the first hundred of three hundred
 * subjects without a word is the kind of quiet truncation that reads as "this
 * is everything".
 */
export const TAXONOMY_PAGE_SIZE = 100;

export function useTaxonomyList(entity: TaxonomyEntity, enabled = true) {
  return useQuery({
    queryKey: ['admin', 'taxonomy', entity],
    queryFn: async () => {
      const { data, meta } = await apiWithMeta<Record<string, unknown>[]>(
        `/taxonomy/${entity}?limit=${TAXONOMY_PAGE_SIZE}`,
      );
      return { items: data, total: Number((meta as { total?: number }).total ?? data.length) };
    },
    enabled,
  });
}

export function useCreateTaxonomy(entity: TaxonomyEntity) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.post(`/taxonomy/${entity}`, input),
    onSuccess: () => invalidateTaxonomy(queryClient, entity),
  });
}

export function useUpdateTaxonomy(entity: TaxonomyEntity) {
  const queryClient = useQueryClient();
  return useMutation({
    // PATCH, not PUT: several of these entities have fields the form does not
    // send, and a partial update is what the endpoint expects.
    mutationFn: (input: { id: string } & Record<string, unknown>) => {
      const { id, ...patch } = input;
      return api.patch(`/taxonomy/${entity}/${id}`, patch);
    },
    onSuccess: () => invalidateTaxonomy(queryClient, entity),
  });
}

export function useDeleteTaxonomy(entity: TaxonomyEntity) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/taxonomy/${entity}/${id}`),
    onSuccess: () => invalidateTaxonomy(queryClient, entity),
  });
}
