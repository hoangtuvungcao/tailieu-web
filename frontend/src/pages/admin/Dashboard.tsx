import { FileText, Flag, HardDrive, Upload, Users } from 'lucide-react';
import { useState } from 'react';

import { LineChart, StatTile } from '@/components/AdminCharts';
import { Card, CardContent, ErrorState, Skeleton } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useAdminStats, useTimeseries } from '@/lib/admin-hooks';
import { formatBytes } from '@/lib/utils';
import { AdminPageHeader } from './AdminLayout';

/**
 * Dashboard.
 *
 * Layout follows the data's job, not a grid: the four headline numbers are a
 * KPI row of stat tiles, and the one trend is a single line chart. A grouped
 * bar chart of "users vs documents vs megabytes" would put four incompatible
 * units on one axis — the classic dual-scale mistake wearing a disguise.
 */
const METRICS = [
  { key: 'documents', label: 'Tài liệu mới' },
  { key: 'users', label: 'Người dùng mới' },
  { key: 'downloads', label: 'Lượt tải' },
  { key: 'uploads', label: 'Phiên tải lên' },
] as const;

const RANGES = [7, 14, 30] as const;

export function AdminDashboardPage() {
  const [metric, setMetric] = useState<(typeof METRICS)[number]['key']>('documents');
  const [days, setDays] = useState<(typeof RANGES)[number]>(14);

  const stats = useAdminStats();
  const series = useTimeseries(metric, days);

  if (stats.isLoading) {
    return (
      <>
        <AdminPageHeader title="Tổng quan" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-28" />
          ))}
        </div>
        <Skeleton className="mt-6 h-64" />
      </>
    );
  }

  if (stats.isError || !stats.data) {
    return (
      <>
        <AdminPageHeader title="Tổng quan" />
        <ErrorState
          message={
            stats.error instanceof ApiError ? stats.error.message : 'Không tải được số liệu.'
          }
          onRetry={() => void stats.refetch()}
        />
      </>
    );
  }

  const data = stats.data;
  const activeMetricLabel = METRICS.find((m) => m.key === metric)?.label ?? '';

  return (
    <>
      <AdminPageHeader
        title="Tổng quan"
        description="Tình trạng nền tảng, cập nhật mỗi 15 giây."
      />

      {/* --- KPI row -------------------------------------------------------- */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Người dùng"
          value={data.users.total}
          icon={<Users className="h-4 w-4" />}
          hint={`${data.users.new7d} mới trong 7 ngày · ${data.users.active30d} hoạt động 30 ngày`}
        />

        <StatTile
          label="Tài liệu"
          value={data.documents.total}
          icon={<FileText className="h-4 w-4" />}
          hint={`${data.documents.published} đã đăng · ${data.documents.downloads} lượt tải`}
        />

        <StatTile
          label="Lưu trữ"
          value={formatBytes(data.storage.bytes)}
          icon={<HardDrive className="h-4 w-4" />}
          hint={
            // Orphans are the number worth surfacing: they are bytes nothing
            // references, and a rising count means the reap job is not running.
            data.storage.orphaned > 0
              ? `${data.storage.objects} đối tượng · ${data.storage.orphaned} mồ côi`
              : `${data.storage.objects} đối tượng · ${data.storage.shared} dùng chung`
          }
        />

        <StatTile
          label="Cần xử lý"
          value={data.moderation.openReports + data.moderation.pendingDocuments}
          icon={<Flag className="h-4 w-4" />}
          // Tone is a status signal, so it only turns when there is something
          // to act on — a permanently amber dashboard trains people to ignore it.
          tone={
            data.moderation.openReports + data.moderation.pendingDocuments > 0 ? 'warning' : 'good'
          }
          hint={`${data.moderation.openReports} báo cáo · ${data.moderation.pendingDocuments} chờ duyệt`}
        />
      </div>

      {/* --- Trend ---------------------------------------------------------- */}
      <Card className="mt-6">
        <CardContent className="p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">
              {activeMetricLabel} theo ngày
            </h2>

            {/* Filters sit in one row above the chart, per the interaction
                spec — not scattered around it. */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-md border border-[var(--color-border)] p-0.5">
                {METRICS.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setMetric(option.key)}
                    aria-pressed={metric === option.key}
                    className={
                      metric === option.key
                        ? 'rounded bg-[var(--color-secondary)] px-2.5 py-1 text-xs font-medium'
                        : 'rounded px-2.5 py-1 text-xs text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]'
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              <div className="flex rounded-md border border-[var(--color-border)] p-0.5">
                {RANGES.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setDays(option)}
                    aria-pressed={days === option}
                    className={
                      days === option
                        ? 'rounded bg-[var(--color-secondary)] px-2.5 py-1 text-xs font-medium'
                        : 'rounded px-2.5 py-1 text-xs text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]'
                    }
                  >
                    {option} ngày
                  </button>
                ))}
              </div>
            </div>
          </div>

          {series.isLoading ? (
            <Skeleton className="h-44" />
          ) : series.isError ? (
            <ErrorState
              message="Không tải được dữ liệu biểu đồ."
              onRetry={() => void series.refetch()}
            />
          ) : (
            /* One series, so no legend — the heading names it. A legend box for
               a single line carries no information. */
            <LineChart data={series.data ?? []} title={activeMetricLabel} height={200} />
          )}

          {/* A table view, so the values are reachable without hovering and by
              a screen reader. */}
          {series.data && series.data.length > 0 ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]">
                Xem dạng bảng
              </summary>
              <div className="mt-2 max-h-48 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-[var(--color-card)]">
                    <tr className="text-left text-[var(--color-muted-foreground)]">
                      <th className="py-1 font-medium">Ngày</th>
                      <th className="py-1 text-right font-medium">{activeMetricLabel}</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {[...series.data].reverse().map((point) => (
                      <tr key={point.date} className="border-t border-[var(--color-border)]">
                        <td className="py-1">{point.date}</td>
                        <td className="py-1 text-right">{point.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </CardContent>
      </Card>

      {/* --- Secondary numbers ---------------------------------------------- */}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <StatTile
          label="Đang tải lên"
          value={data.uploads.inProgress}
          icon={<Upload className="h-4 w-4" />}
          hint="Phiên tải lên chưa hoàn tất"
        />
        <StatTile
          label="Tài liệu chờ duyệt"
          value={data.documents.pendingReview}
          tone={data.documents.pendingReview > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Tài khoản bị tạm ngưng"
          value={data.users.suspended}
          tone={data.users.suspended > 0 ? 'warning' : 'neutral'}
        />
      </div>
    </>
  );
}
