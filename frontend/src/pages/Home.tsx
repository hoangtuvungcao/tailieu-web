import { BookOpen, Search, Sparkles, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { DocumentCard, DocumentCardSkeleton } from '@/components/DocumentCard';
import { Button, Card, CardContent, EmptyState, ErrorState, Input } from '@/components/ui';
import { useDocuments, useFaculties } from '@/lib/hooks';
import { ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/**
 * Homepage.
 *
 * One large search box, because search is the primary action on a document
 * platform — everything else is secondary navigation. The quick faculty chips
 * exist so a visitor who does not yet know what to search for has somewhere to
 * click rather than an empty box.
 */
export function HomePage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  const recent = useDocuments({ sort: 'newest', limit: 8 });
  const popular = useDocuments({ sort: 'popular', limit: 4 });
  const faculties = useFaculties();

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = query.trim();
    navigate(trimmed ? `/documents?q=${encodeURIComponent(trimmed)}` : '/documents');
  }

  return (
    <div className="container-page py-10">
      {/* --- Hero ---------------------------------------------------------- */}
      <section className="mx-auto max-w-3xl text-center">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Kho tri thức Đại học Tây Nguyên
        </h1>
        <p className="mt-3 text-[var(--color-muted-foreground)]">
          Chia sẻ • Khám phá • Học tập • Kết nối
        </p>

        <form onSubmit={submitSearch} className="mt-8" role="search">
          {/* Stacks below `sm`: at 320px a 48px-tall input next to a
              "Tìm kiếm" button leaves the input too narrow to read what was
              typed. */}
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-foreground)]"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Tìm bài giảng, đề thi, giáo trình, học phần…"
                aria-label="Tìm kiếm tài liệu"
                className="h-12 pl-10 text-base"
              />
            </div>
            <Button type="submit" size="lg" className="sm:w-auto">
              Tìm kiếm
            </Button>
          </div>
        </form>

        {/* Quick faculty filters. Rendered from the API, so a faculty added in
            the admin panel appears here with no frontend release. */}
        {faculties.data && faculties.data.length > 0 ? (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {faculties.data.slice(0, 7).map((faculty) => (
              <Link
                key={faculty.id}
                to={`/documents?facultyId=${faculty.id}`}
                className={cn(
                  'rounded-full border border-[var(--color-border)] px-3 py-1 text-xs',
                  'hover:border-[var(--color-brand-400)] hover:bg-[var(--color-brand-50)] hover:text-[var(--color-brand-800)]',
                )}
              >
                {faculty.shortName ?? faculty.name}
              </Link>
            ))}
          </div>
        ) : null}
      </section>

      {/* --- Popular ------------------------------------------------------- */}
      {/* Ranked by downloads rather than recency: on a new platform the newest
          items are often empty, and showing four blank cards is worse than
          showing none. */}
      <Section
        title="Tài liệu được tải nhiều"
        icon={<TrendingUp className="h-5 w-5" />}
        href="/documents?sort=popular"
        isLoading={popular.isLoading}
        isError={popular.isError}
        error={popular.error}
        isEmpty={popular.data?.documents.length === 0}
        onRetry={() => void popular.refetch()}
        emptyMessage="Chưa có tài liệu nào được tải xuống."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {popular.data?.documents.map((document) => (
            <DocumentCard key={document.id} document={document} />
          ))}
        </div>
      </Section>

      {/* --- Recent -------------------------------------------------------- */}
      <Section
        title="Tài liệu mới nhất"
        icon={<Sparkles className="h-5 w-5" />}
        href="/documents?sort=newest"
        isLoading={recent.isLoading}
        isError={recent.isError}
        error={recent.error}
        isEmpty={recent.data?.documents.length === 0}
        onRetry={() => void recent.refetch()}
        emptyMessage="Chưa có tài liệu nào. Hãy là người đầu tiên chia sẻ!"
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {recent.data?.documents.map((document) => (
            <DocumentCard key={document.id} document={document} />
          ))}
        </div>
      </Section>
    </div>
  );
}

function Section({
  title,
  icon,
  href,
  isLoading,
  isError,
  error,
  isEmpty,
  emptyMessage,
  onRetry,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  href: string;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isEmpty: boolean | undefined;
  emptyMessage: string;
  onRetry: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-12">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <span className="text-[var(--color-brand-600)]" aria-hidden>
            {icon}
          </span>
          {title}
        </h2>
        <Link
          to={href}
          className="text-sm font-medium text-[var(--color-primary)] hover:underline"
        >
          Xem tất cả
        </Link>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <DocumentCardSkeleton key={index} />
          ))}
        </div>
      ) : isError ? (
        <ErrorState
          message={error instanceof ApiError ? error.message : 'Không tải được dữ liệu.'}
          onRetry={onRetry}
        />
      ) : isEmpty ? (
        <EmptyState icon={<BookOpen className="h-8 w-8" />} title={emptyMessage} />
      ) : (
        children
      )}
    </section>
  );
}

/** Small card used on the homepage sidebar in future iterations. */
export function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-[var(--color-muted-foreground)]">{label}</p>
        <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}
