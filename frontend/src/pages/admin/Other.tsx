import { Flag, HardDrive, Save } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Badge, Button, Card, CardContent, EmptyState, ErrorState, Input, Skeleton } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import {
  useAdminReports,
  useAdminSettings,
  useAuditLog,
  useResolveReport,
  useStorageOverview,
  useUpdateSettings,
} from '@/lib/admin-hooks';
import { formatBytes, formatRelativeTime } from '@/lib/utils';
import { AdminPageHeader } from './AdminLayout';

/**
 * Remaining admin screens.
 *
 * Grouped in one file because each is a single table or form over one endpoint —
 * splitting them into five files of sixty lines each would add navigation cost
 * without adding clarity. The layout, dashboard and users screens are separate
 * because they carry real logic.
 */

const REASON_LABELS: Record<string, string> = {
  spam: 'Spam',
  copyright: 'Vi phạm bản quyền',
  malware: 'Mã độc',
  wrong_content: 'Nội dung sai',
  sensitive: 'Nội dung nhạy cảm',
  harassment: 'Quấy rối',
  fake_document: 'Tài liệu giả',
  misleading: 'Thông tin gây nhầm lẫn',
  other: 'Khác',
};

// =============================================================================
// Reports
// =============================================================================

export function AdminReportsPage() {
  const [status, setStatus] = useState('pending');
  const [page, setPage] = useState(1);
  const [note, setNote] = useState<Record<string, string>>({});

  const query = useAdminReports({ status: status || undefined, page, limit: 25 });
  const resolve = useResolveReport();
  const [error, setError] = useState<string | null>(null);

  async function act(id: string, next: 'resolved' | 'rejected' | 'reviewing'): Promise<void> {
    setError(null);
    try {
      await resolve.mutateAsync({ id, status: next, note: note[id] });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Không xử lý được báo cáo.');
    }
  }

  return (
    <>
      <AdminPageHeader
        title="Báo cáo"
        description="Nội dung bị người dùng báo cáo, cũ nhất trước."
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-md border border-[var(--color-destructive)]/30 px-3 py-2 text-sm text-[var(--color-destructive)]">
          {error}
        </p>
      ) : null}

      <div className="mb-4 flex rounded-md border border-[var(--color-border)] p-0.5">
        {[
          { key: 'pending', label: 'Chờ xử lý' },
          { key: 'reviewing', label: 'Đang xem' },
          { key: 'resolved', label: 'Đã xử lý' },
          { key: 'rejected', label: 'Đã bỏ qua' },
        ].map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => {
              setStatus(option.key);
              setPage(1);
            }}
            aria-pressed={status === option.key}
            className={
              status === option.key
                ? 'rounded bg-[var(--color-secondary)] px-3 py-1 text-xs font-medium'
                : 'rounded px-3 py-1 text-xs text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]'
            }
          >
            {option.label}
          </button>
        ))}
      </div>

      {query.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState message="Không tải được hàng đợi báo cáo." onRetry={() => void query.refetch()} />
      ) : query.data?.reports.length === 0 ? (
        <EmptyState
          icon={<Flag className="h-8 w-8" />}
          title="Không có báo cáo nào"
          description="Hàng đợi trống — không có gì cần xử lý."
        />
      ) : (
        <div className="space-y-3">
          {query.data?.reports.map((report) => (
            <Card key={report.id}>
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <Badge variant="warning">{REASON_LABELS[report.reason] ?? report.reason}</Badge>
                    <p className="mt-1.5 text-sm">
                      <span className="font-medium">{report.targetType}</span>{' '}
                      <code className="text-xs text-[var(--color-muted-foreground)]">
                        {report.targetId.slice(0, 8)}…
                      </code>
                    </p>
                  </div>
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    {report.reporterName} · {formatRelativeTime(report.createdAt)}
                  </p>
                </div>

                {report.details ? (
                  <p className="rounded-md bg-[var(--color-muted)] px-3 py-2 text-sm">
                    {report.details}
                  </p>
                ) : null}

                {report.status === 'pending' || report.status === 'reviewing' ? (
                  <div className="flex flex-wrap gap-2">
                    <Input
                      value={note[report.id] ?? ''}
                      onChange={(event) =>
                        setNote((current) => ({ ...current, [report.id]: event.target.value }))
                      }
                      placeholder="Ghi chú xử lý (tuỳ chọn)…"
                      aria-label="Ghi chú xử lý"
                      className="min-w-48 flex-1"
                    />
                    <Button
                      size="sm"
                      isLoading={resolve.isPending}
                      onClick={() => void act(report.id, 'resolved')}
                    >
                      Xử lý
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void act(report.id, 'rejected')}
                    >
                      Bỏ qua
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    {report.status === 'resolved' ? 'Đã xử lý' : 'Đã bỏ qua'}
                    {report.resolutionNote ? ` — ${report.resolutionNote}` : ''}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

// =============================================================================
// Audit log
// =============================================================================

export function AdminAuditPage() {
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const query = useAuditLog({ action: action || undefined, page, limit: 50 });

  return (
    <>
      <AdminPageHeader
        title="Nhật ký kiểm toán"
        description="Mọi hành động quản trị và bảo mật, có ghi ai làm và khi nào."
      />

      <div className="mb-4">
        <Input
          value={action}
          onChange={(event) => {
            setAction(event.target.value);
            setPage(1);
          }}
          placeholder="Lọc theo hành động, ví dụ: role.granted…"
          aria-label="Lọc theo hành động"
          className="max-w-sm"
        />
      </div>

      {query.isLoading ? (
        <Skeleton className="h-96" />
      ) : query.isError ? (
        <ErrorState message="Không tải được nhật ký." onRetry={() => void query.refetch()} />
      ) : query.data?.entries.length === 0 ? (
        <EmptyState title="Không có bản ghi nào" />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-muted-foreground)]">
                    <th className="px-4 py-2 font-medium">Hành động</th>
                    <th className="px-4 py-2 font-medium">Người thực hiện</th>
                    <th className="px-4 py-2 font-medium">Đối tượng</th>
                    <th className="px-4 py-2 font-medium">Thời gian</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data?.entries.map((entry) => (
                    <tr key={entry.id} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="px-4 py-2">
                        <code className="text-xs">{entry.action}</code>
                      </td>
                      <td className="px-4 py-2 text-xs">
                        {entry.actorName ?? '—'}
                        {entry.actorEmail ? (
                          <span className="block text-[var(--color-muted-foreground)]">
                            {entry.actorEmail}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2 text-xs text-[var(--color-muted-foreground)]">
                        {entry.targetType ? `${entry.targetType}` : '—'}
                      </td>
                      <td className="px-4 py-2 text-xs text-[var(--color-muted-foreground)]">
                        {formatRelativeTime(entry.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {query.data && query.data.meta.totalPages > 1 ? (
        <nav className="mt-4 flex justify-center gap-3">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Trước
          </Button>
          <span className="text-sm tabular-nums text-[var(--color-muted-foreground)]">
            {query.data.meta.page} / {query.data.meta.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= query.data.meta.totalPages}
            onClick={() => setPage(page + 1)}
          >
            Sau
          </Button>
        </nav>
      ) : null}
    </>
  );
}

// =============================================================================
// Storage
// =============================================================================

export function AdminStoragePage() {
  const query = useStorageOverview();

  return (
    <>
      <AdminPageHeader
        title="Lưu trữ"
        description="Dung lượng, tệp lớn nhất và đối tượng mồ côi."
      />

      {query.isLoading ? (
        <Skeleton className="h-64" />
      ) : query.isError || !query.data ? (
        <ErrorState message="Không tải được số liệu lưu trữ." onRetry={() => void query.refetch()} />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-[var(--color-muted-foreground)]">Tổng dung lượng</p>
                <p className="mt-1 text-2xl font-bold tabular-nums">
                  {formatBytes(query.data.bytes)}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-[var(--color-muted-foreground)]">Đối tượng</p>
                <p className="mt-1 text-2xl font-bold tabular-nums">{query.data.objects}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-[var(--color-muted-foreground)]">Mồ côi</p>
                <p
                  className={
                    query.data.orphaned > 0
                      ? 'mt-1 text-2xl font-bold tabular-nums text-[var(--color-gold-600)]'
                      : 'mt-1 text-2xl font-bold tabular-nums'
                  }
                >
                  {query.data.orphaned}
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent className="p-4">
              <h2 className="mb-3 text-sm font-semibold">Tệp lớn nhất</h2>
              <div className="space-y-1.5">
                {query.data.largest.map((object) => (
                  <div
                    key={object.objectKey}
                    className="flex items-center justify-between rounded-md border border-[var(--color-border)] px-3 py-2 text-xs"
                  >
                    <code className="truncate">{object.objectKey}</code>
                    <div className="ml-3 flex shrink-0 items-center gap-2">
                      {/* Hidden on phones. A MIME type runs to 70 characters
                          ("application/vnd.openxmlformats-officedocument…"),
                          which is wider than the whole card — and it is the
                          least useful thing in this row. Shown from `sm`. */}
                      <Badge variant="outline" className="hidden sm:inline-flex">
                        {object.mimeType}
                      </Badge>
                      <span className="tabular-nums">{formatBytes(object.sizeBytes)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {query.data.orphaned > 0 ? (
            <div className="rounded-lg border border-[var(--color-gold-300)] bg-[var(--color-gold-50)] p-4 text-sm text-[var(--color-gold-700)]">
              <p className="flex items-start gap-2">
                <HardDrive className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span>
                  Có {query.data.orphaned} đối tượng không được tài liệu nào tham chiếu. Chạy{' '}
                  <code className="font-mono text-xs">npm run cleanup</code> để dọn — mặc định chỉ
                  báo cáo, thêm <code className="font-mono text-xs">--delete-orphans</code> mới xoá
                  thật.
                </span>
              </p>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}

// =============================================================================
// Settings
// =============================================================================

const CATEGORY_LABELS: Record<string, string> = {
  system: 'Hệ thống',
  uploads: 'Tải lên',
  community: 'Cộng đồng',
  reputation: 'Uy tín',
  branding: 'Thương hiệu',
  general: 'Khác',
};

export function AdminSettingsPage() {
  const query = useAdminSettings();
  const update = useUpdateSettings();
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState(false);

  // Reset the draft when fresh data arrives, so a refetch does not leave stale
  // local edits sitting on top of values someone else just changed.
  useEffect(() => {
    setDraft({});
  }, [query.data]);

  if (query.isLoading) return <Skeleton className="h-96" />;
  if (query.isError || !query.data) {
    return <ErrorState message="Không tải được cài đặt." onRetry={() => void query.refetch()} />;
  }

  const dirtyKeys = Object.keys(draft);

  async function save(): Promise<void> {
    await update.mutateAsync(draft);
    setDraft({});
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  return (
    <>
      <AdminPageHeader
        title="Cài đặt"
        description="Thay đổi có hiệu lực trong vòng 30 giây, không cần khởi động lại."
        actions={
          <Button disabled={dirtyKeys.length === 0} isLoading={update.isPending} onClick={() => void save()}>
            <Save className="h-4 w-4" />
            Lưu {dirtyKeys.length > 0 ? `(${dirtyKeys.length})` : ''}
          </Button>
        }
      />

      {saved ? (
        <p className="mb-4 rounded-md border border-[var(--color-success)]/40 bg-[color-mix(in_oklch,var(--color-success)_8%,transparent)] px-3 py-2 text-sm">
          Đã lưu cài đặt.
        </p>
      ) : null}

      <div className="space-y-6">
        {Object.entries(query.data.grouped).map(([category, entries]) => (
          <Card key={category}>
            <CardContent className="space-y-4 p-4">
              <h2 className="text-sm font-semibold">
                {CATEGORY_LABELS[category] ?? category}
              </h2>

              {entries.map((entry) => {
                const value = entry.key in draft ? draft[entry.key] : entry.value;
                const isBoolean = typeof entry.value === 'boolean';
                const isObject = typeof entry.value === 'object' && entry.value !== null;

                return (
                  <div key={entry.key} className="space-y-1.5">
                    <label
                      htmlFor={`setting-${entry.key}`}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <span className="font-mono text-xs">{entry.key}</span>

                      {isBoolean ? (
                        <input
                          id={`setting-${entry.key}`}
                          type="checkbox"
                          checked={Boolean(value)}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              [entry.key]: event.target.checked,
                            }))
                          }
                          className="h-4 w-4"
                        />
                      ) : isObject ? (
                        // Free-form JSON, edited as text. A structured editor per
                        // setting would be a schema for each one, and these change
                        // shape between releases.
                        <Input
                          id={`setting-${entry.key}`}
                          defaultValue={JSON.stringify(entry.value)}
                          onChange={(event) => {
                            try {
                              const parsed: unknown = JSON.parse(event.target.value);
                              setDraft((current) => ({ ...current, [entry.key]: parsed }));
                            } catch {
                              // Invalid JSON mid-typing is normal; the value is
                              // simply not staged until it parses.
                            }
                          }}
                          className="max-w-xs font-mono text-xs"
                        />
                      ) : (
                        <Input
                          id={`setting-${entry.key}`}
                          type={typeof entry.value === 'number' ? 'number' : 'text'}
                          defaultValue={String(entry.value)}
                          onChange={(event) =>
                            setDraft((current) => ({
                              ...current,
                              [entry.key]:
                                typeof entry.value === 'number'
                                  ? Number(event.target.value)
                                  : event.target.value,
                            }))
                          }
                          className="max-w-xs"
                        />
                      )}
                    </label>
                    {entry.description ? (
                      <p className="text-[11px] text-[var(--color-muted-foreground)]">
                        {entry.description}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
