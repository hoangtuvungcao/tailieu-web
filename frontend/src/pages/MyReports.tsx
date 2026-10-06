import { Flag } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Badge, Button, Card, CardContent, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { reportReasonLabel, reportTargetLabel, useMyReports } from '@/lib/report-hooks';
import { formatRelativeTime } from '@/lib/utils';

/**
 * The reports you filed, and what came of them.
 *
 * The other half of the dialog. Reporting without ever hearing back trains
 * people to stop reporting — they cannot tell a queue that ignored them from
 * one that acted, so the only rational move is to stop bothering. This page is
 * the answer to "what happened to it".
 *
 * It shows the reporter their own rows and nothing else: the server scopes
 * `/reports/mine` by reporter, and the moderator's identity is not in the
 * payload. A reporter is told the outcome, not who decided it, because a
 * moderator who can be named in a list is a moderator who gets argued with.
 */

const STATUS: Record<
  string,
  { label: string; variant: 'default' | 'warning' | 'success' | 'outline'; hint: string }
> = {
  pending: {
    label: 'Chờ xử lý',
    variant: 'warning',
    hint: 'Đã gửi và đang chờ kiểm duyệt viên xem.',
  },
  reviewing: {
    label: 'Đang xem xét',
    variant: 'default',
    hint: 'Kiểm duyệt viên đang xem xét báo cáo này.',
  },
  resolved: {
    label: 'Đã xử lý',
    variant: 'success',
    hint: 'Báo cáo đã được xử lý.',
  },
  rejected: {
    label: 'Đã bỏ qua',
    variant: 'outline',
    hint: 'Kiểm duyệt viên xem xét và thấy nội dung không vi phạm.',
  },
};

/**
 * Where a report's subject lives, when it still has a page.
 *
 * `comment` has no page of its own, so those rows name the type and stop.
 */
const TARGET_ROUTES: Record<string, (id: string) => string> = {
  document: (id) => `/documents/${id}`,
  post: (id) => `/community/${id}`,
  user: (id) => `/users/${id}`,
  collection: (id) => `/collections/${id}`,
};

export function MyReportsPage() {
  const [page, setPage] = useState(1);
  const query = useMyReports(page);

  const reports = query.data?.data ?? [];
  const meta = query.data?.meta;

  return (
    <div className="container-page py-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-bold tracking-tight">Báo cáo của tôi</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Những nội dung bạn đã báo cáo và tình trạng xử lý.
        </p>

        <div className="mt-6">
          {query.isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-28" />
              ))}
            </div>
          ) : query.isError ? (
            <ErrorState
              message="Không tải được danh sách báo cáo."
              onRetry={() => void query.refetch()}
            />
          ) : reports.length === 0 ? (
            <EmptyState
              icon={<Flag className="h-8 w-8" />}
              title="Bạn chưa gửi báo cáo nào"
              description="Khi thấy tài liệu sai hoặc có vấn đề, dùng nút “Báo cáo tài liệu này” ở trang tài liệu. Báo cáo bạn gửi sẽ được liệt kê tại đây."
            />
          ) : (
            <div className="space-y-3">
              {reports.map((report) => {
                const status = STATUS[report.status] ?? {
                  label: report.status,
                  variant: 'outline' as const,
                  hint: '',
                };
                const href = TARGET_ROUTES[report.targetType]?.(report.targetId);

                return (
                  <Card key={report.id}>
                    <CardContent className="space-y-2 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={status.variant}>{status.label}</Badge>
                          <span className="text-sm font-medium">
                            {reportReasonLabel(report.reason)}
                          </span>
                        </div>
                        <span className="text-xs text-[var(--color-muted-foreground)]">
                          {formatRelativeTime(report.createdAt)}
                        </span>
                      </div>

                      <p className="text-xs text-[var(--color-muted-foreground)]">
                        {reportTargetLabel(report.targetType)}{' '}
                        {href ? (
                          <Link
                            to={href}
                            className="text-[var(--color-primary)] underline-offset-2 hover:underline"
                          >
                            Mở để xem
                          </Link>
                        ) : (
                          <code>{report.targetId.slice(0, 8)}…</code>
                        )}
                      </p>

                      <p className="text-xs text-[var(--color-muted-foreground)]">{status.hint}</p>

                      {/* The moderator's note, when there is one. It is the only
                          place the reporter learns *why* — the status alone
                          leaves "resolved" covering both "removed" and "left
                          up, we checked it". */}
                      {report.resolutionNote ? (
                        <p className="rounded-md bg-[var(--color-muted)] px-3 py-2 text-sm">
                          {report.resolutionNote}
                        </p>
                      ) : null}
                    </CardContent>
                  </Card>
                );
              })}

              {meta && meta.totalPages > 1 ? (
                <div className="flex items-center justify-between pt-2">
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    Trang {meta.page}/{meta.totalPages} · {meta.total} báo cáo
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page <= 1}
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                    >
                      Trước
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= meta.totalPages}
                      onClick={() => setPage((current) => current + 1)}
                    >
                      Sau
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
