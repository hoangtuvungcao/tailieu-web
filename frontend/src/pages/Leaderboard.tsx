import { Trophy } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Avatar, Card, CardContent, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { useFaculties } from '@/lib/hooks';
import { useLeaderboard } from '@/lib/social-hooks';
import { cn } from '@/lib/utils';

/**
 * Monthly leaderboard.
 *
 * Monthly only, and the tab list says so rather than offering periods that
 * would come back empty: semester and yearly boards need running totals keyed
 * by the semester, and nothing maintains those yet.
 *
 * The viewer's own row is shown even when they are nowhere near the top, which
 * is the difference between a leaderboard that motivates and one that only
 * flatters the people already at the top. Somebody with no points gets no row
 * at all rather than a fabricated rank.
 */

type Scope = 'university' | 'faculty';

export function LeaderboardPage() {
  const { user } = useAuth();
  const [scope, setScope] = useState<Scope>('university');

  const faculties = useFaculties();
  const facultyId = user?.primaryFacultyId ?? undefined;

  // Only offered when there is a faculty to scope to. A tab that always errors
  // or always shows nothing is worse than no tab.
  const tabs: { key: Scope; label: string; scopeId?: string }[] = [
    { key: 'university', label: 'Toàn trường' },
  ];
  if (facultyId) {
    tabs.push({
      key: 'faculty',
      label: faculties.data?.find((f) => f.id === facultyId)?.name ?? 'Khoa của tôi',
      scopeId: facultyId,
    });
  }

  const active = tabs.find((tab) => tab.key === scope) ?? tabs[0]!;
  const query = useLeaderboard(
    active.scopeId ? { scope: active.key, scopeId: active.scopeId } : { scope: active.key },
  );

  const data = query.data;

  return (
    <div className="container-page py-8">
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
              <Trophy className="h-6 w-6 text-[var(--color-brand-600)]" aria-hidden />
              Bảng xếp hạng
            </h1>
            <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
              Uy tín nhận được từ nội dung của bạn trong tháng
              {data ? ` ${data.periodKey}` : ''}.
            </p>
          </div>
        </div>

        {tabs.length > 1 ? (
          <div className="mt-4 flex rounded-md border border-[var(--color-border)] p-0.5 w-fit">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                aria-pressed={scope === tab.key}
                onClick={() => setScope(tab.key)}
                className={cn(
                  'rounded px-3 py-1 text-xs font-medium',
                  scope === tab.key
                    ? 'bg-[var(--color-secondary)]'
                    : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        ) : null}

        {/* Your own standing, whether or not you are in the list below. */}
        {data?.viewer ? (
          <Card className="mt-4">
            <CardContent className="flex items-center gap-3 p-4">
              <span className="text-lg font-semibold tabular-nums">#{data.viewer.rank}</span>
              <span className="text-sm">Vị trí của bạn</span>
              <span className="ml-auto text-sm font-medium tabular-nums">
                {data.viewer.score} điểm
              </span>
            </CardContent>
          </Card>
        ) : null}

        <div className="mt-6">
          {query.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-16 rounded-lg" />
              ))}
            </div>
          ) : query.isError ? (
            <ErrorState
              message={
                query.error instanceof ApiError
                  ? query.error.message
                  : 'Đã xảy ra lỗi khi tải bảng xếp hạng.'
              }
              onRetry={() => void query.refetch()}
            />
          ) : !data || data.entries.length === 0 ? (
            <EmptyState
              icon={<Trophy className="h-8 w-8" />}
              title="Chưa có ai trên bảng"
              description="Khi nội dung của thành viên được người khác thích trong tháng này, họ sẽ xuất hiện ở đây."
            />
          ) : (
            <ol className="space-y-2">
              {data.entries.map((entry) => (
                <li key={entry.userId}>
                  <Link
                    to={`/users/${entry.userId}`}
                    className={cn(
                      'flex items-center gap-3 rounded-lg border p-3 transition-colors',
                      entry.isViewer
                        ? 'border-[var(--color-primary)] bg-[var(--color-muted)]/40'
                        : 'border-[var(--color-border)] hover:border-[var(--color-primary)]',
                    )}
                  >
                    <span
                      className={cn(
                        'w-8 shrink-0 text-center text-sm font-semibold tabular-nums',
                        entry.rank <= 3
                          ? 'text-[var(--color-brand-600)]'
                          : 'text-[var(--color-muted-foreground)]',
                      )}
                    >
                      {entry.rank}
                    </span>
                    <Avatar name={entry.displayName} src={entry.avatarUrl} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {entry.displayName}
                    </span>
                    <span className="shrink-0 text-sm tabular-nums">{entry.score}</span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
