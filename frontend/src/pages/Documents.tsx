import { Search, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { DocumentCard, DocumentCardSkeleton } from '@/components/DocumentCard';
import { Button, EmptyState, ErrorState, Input } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useDocumentTypes, useDocuments, useFaculties, useSearch } from '@/lib/hooks';
import { cn } from '@/lib/utils';

/**
 * Document browse and search.
 *
 * All state lives in the URL. That makes a filtered view shareable and
 * bookmarkable, and makes the back button behave — the two things users
 * actually notice about a browse page. It also means the browser's own history
 * is the source of truth, so there is no client state to drift out of sync
 * with what is displayed.
 */

const SORT_OPTIONS = [
  { value: 'relevance', label: 'Liên quan nhất' },
  { value: 'newest', label: 'Mới nhất' },
  { value: 'popular', label: 'Tải nhiều nhất' },
  { value: 'rated', label: 'Đánh giá cao' },
  { value: 'title', label: 'Theo tên A–Z' },
];

const FILE_KINDS = [
  { value: 'pdf', label: 'PDF' },
  { value: 'document', label: 'Văn bản' },
  { value: 'spreadsheet', label: 'Bảng tính' },
  { value: 'presentation', label: 'Slide' },
  { value: 'image', label: 'Hình ảnh' },
  { value: 'archive', label: 'Nén' },
  { value: 'code', label: 'Mã nguồn' },
];

export function DocumentsPage() {
  const [params, setParams] = useSearchParams();
  const [showFilters, setShowFilters] = useState(false);

  const query = params.get('q') ?? '';
  const facultyId = params.get('facultyId') ?? undefined;
  const documentTypeId = params.get('documentTypeId') ?? undefined;
  const fileKind = params.get('fileKind') ?? undefined;
  // Set by a public profile's document count. Not in the filter panel — it is
  // not something you pick, it is where you arrived from, so it shows as a chip
  // you can drop rather than a control you can set.
  const ownerUserId = params.get('ownerUserId') ?? undefined;
  // Set by a tag badge on a document page. Like `ownerUserId`, it is somewhere
  // you arrived from rather than something you pick, so it shows as a chip.
  //
  // The backend has always accepted `tag`; this page simply never read it, so
  // every tag on every document was a link to an unfiltered list — it looked
  // like it had worked and had only shown you everything.
  const tag = params.get('tag') ?? undefined;
  const sort = params.get('sort') ?? (query ? 'relevance' : 'newest');
  const page = Number(params.get('page') ?? '1');

  // Local state mirrors the URL so typing does not push a history entry per
  // keystroke; the URL updates on submit.
  const [searchInput, setSearchInput] = useState(query);
  useEffect(() => setSearchInput(query), [query]);

  const filters = { q: query || undefined, facultyId, documentTypeId, fileKind, ownerUserId, tag, sort, page, limit: 20 };

  // Two hooks, one result: the search endpoint when there is a query, the plain
  // list otherwise. They return different shapes (search adds highlights and a
  // score), and keeping them separate avoids pretending a browse is a search
  // with an empty term.
  const listQuery = useDocuments(query ? { ...filters, q: undefined, sort } : filters);
  // Every filter has to be passed on both paths. `ownerUserId` and `tag` were
  // missing from this call, so typing a search term silently dropped them —
  // you would search within a tag and get results from the whole library.
  const searchQuery = useSearch(query, {
    facultyId,
    documentTypeId,
    fileKind,
    ownerUserId,
    tag,
    sort,
    page,
    limit: 20,
  });

  const active = query ? searchQuery : listQuery;
  const faculties = useFaculties();
  const documentTypes = useDocumentTypes();

  function updateParam(key: string, value: string | undefined) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    // Any filter change resets to page 1. Staying on page 7 of a newly
    // filtered result set usually lands on an empty page.
    if (key !== 'page') next.delete('page');
    setParams(next);
  }

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    updateParam('q', searchInput.trim() || undefined);
  }

  const activeFilterCount = [facultyId, documentTypeId, fileKind, ownerUserId, tag].filter(Boolean).length;

  const documents = query
    ? (searchQuery.data?.hits.map((hit) => ({
        document: hit.document,
        highlightTitle: hit.highlights.find((h) => h.field === 'title')?.value,
      })) ?? [])
    : (listQuery.data?.documents.map((document) => ({ document, highlightTitle: undefined })) ?? []);

  const meta = active.data
    ? query
      ? (searchQuery.data?.meta ?? null)
      : (listQuery.data?.meta ?? null)
    : null;

  return (
    <div className="container-page py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Tài liệu</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Tìm kiếm và lọc tài liệu theo khoa, ngành, học phần và định dạng.
        </p>
      </div>

      {/* Two rows below `sm`. Three controls on one line leaves the input
          about 120px wide at 360px — narrow enough that the placeholder is
          unreadable and typing is guesswork. */}
      <form onSubmit={submitSearch} role="search" className="space-y-2 sm:space-y-0 sm:flex sm:gap-2">
        <div className="flex flex-1 gap-2">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-foreground)]"
              aria-hidden
            />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Nhập từ khoá tìm kiếm…"
              aria-label="Tìm kiếm tài liệu"
              className="pl-10"
            />
          </div>
          <Button type="submit" className="shrink-0">
            Tìm
          </Button>
        </div>

        <Button
          type="button"
          variant="outline"
          onClick={() => setShowFilters((open) => !open)}
          aria-expanded={showFilters}
          className="w-full gap-2 sm:hidden"
        >
          <SlidersHorizontal className="h-4 w-4" />
          Bộ lọc
          {activeFilterCount > 0 ? (
            <span className="rounded-full bg-[var(--color-primary)] px-1.5 text-xs text-[var(--color-primary-foreground)]">
              {activeFilterCount}
            </span>
          ) : null}
        </Button>

        {/* On wider screens the toggle sits beside the search box instead of
            taking a full row of its own. */}
        <div className="hidden sm:block">
          <Button
            type="button"
            variant="outline"
            onClick={() => setShowFilters((open) => !open)}
            aria-expanded={showFilters}
            className="gap-2 shrink-0"
          >
            <SlidersHorizontal className="h-4 w-4" />
            Bộ lọc
            {activeFilterCount > 0 ? (
              <span className="rounded-full bg-[var(--color-primary)] px-1.5 text-xs text-[var(--color-primary-foreground)]">
                {activeFilterCount}
              </span>
            ) : null}
          </Button>
        </div>
      </form>

      {showFilters ? (
        <div className="mt-4 grid gap-4 rounded-lg border border-[var(--color-border)] p-4 sm:grid-cols-2 lg:grid-cols-4">
          <FilterSelect
            label="Khoa"
            value={facultyId}
            onChange={(value) => updateParam('facultyId', value)}
            options={(faculties.data ?? []).map((f) => ({ value: f.id, label: f.name }))}
            placeholder="Tất cả khoa"
          />
          <FilterSelect
            label="Loại tài liệu"
            value={documentTypeId}
            onChange={(value) => updateParam('documentTypeId', value)}
            options={(documentTypes.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
            placeholder="Tất cả loại"
          />
          <FilterSelect
            label="Định dạng"
            value={fileKind}
            onChange={(value) => updateParam('fileKind', value)}
            options={FILE_KINDS}
            placeholder="Tất cả định dạng"
          />
          <FilterSelect
            label="Sắp xếp"
            value={sort}
            onChange={(value) => updateParam('sort', value)}
            options={SORT_OPTIONS}
            placeholder="Mới nhất"
          />
        </div>
      ) : null}

      {activeFilterCount > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-[var(--color-muted-foreground)]">Đang lọc:</span>
          {facultyId ? (
            <FilterChip
              label={faculties.data?.find((f) => f.id === facultyId)?.name ?? 'Khoa'}
              onClear={() => updateParam('facultyId', undefined)}
            />
          ) : null}
          {documentTypeId ? (
            <FilterChip
              label={documentTypes.data?.find((t) => t.id === documentTypeId)?.name ?? 'Loại'}
              onClear={() => updateParam('documentTypeId', undefined)}
            />
          ) : null}
          {fileKind ? (
            <FilterChip
              label={FILE_KINDS.find((k) => k.value === fileKind)?.label ?? fileKind}
              onClear={() => updateParam('fileKind', undefined)}
            />
          ) : null}
          {tag ? (
            <FilterChip label={`Thẻ: ${tag}`} onClear={() => updateParam('tag', undefined)} />
          ) : null}
          {ownerUserId ? (
            // No name to show: the profile page is the only thing that knows it,
            // and fetching a profile to label a chip would be a request for
            // nothing. The wording says where the filter came from instead.
            <FilterChip
              label="Tài liệu của một tác giả"
              onClear={() => updateParam('ownerUserId', undefined)}
            />
          ) : null}
        </div>
      ) : null}

      <div className="mt-6" aria-live="polite" aria-busy={active.isLoading}>
        {meta ? (
          <p className="mb-3 text-sm text-[var(--color-muted-foreground)]">
            {meta.total} kết quả
            {query ? ` cho “${query}”` : ''}
            {typeof meta === 'object' && 'tookMs' in meta
              ? ` · ${(meta as { tookMs: number }).tookMs}ms`
              : ''}
          </p>
        ) : null}

        {active.isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <DocumentCardSkeleton key={index} />
            ))}
          </div>
        ) : active.isError ? (
          <ErrorState
            message={active.error instanceof ApiError ? active.error.message : 'Không tải được tài liệu.'}
            onRetry={() => void active.refetch()}
          />
        ) : documents.length === 0 ? (
          <EmptyState
            icon={<Search className="h-8 w-8" />}
            title={query ? `Không tìm thấy kết quả cho “${query}”` : 'Chưa có tài liệu nào'}
            description={
              query
                ? 'Thử từ khoá khác, hoặc bỏ một vài bộ lọc để mở rộng kết quả.'
                : 'Hãy là người đầu tiên chia sẻ tài liệu cho cộng đồng.'
            }
            action={
              activeFilterCount > 0 ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    const next = new URLSearchParams();
                    if (query) next.set('q', query);
                    setParams(next);
                  }}
                >
                  Xoá bộ lọc
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {documents.map(({ document, highlightTitle }) => (
              <DocumentCard
                key={document.id}
                document={document}
                highlightTitle={highlightTitle}
              />
            ))}
          </div>
        )}
      </div>

      {meta && meta.totalPages > 1 ? (
        <nav aria-label="Phân trang" className="mt-8 flex items-center justify-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => updateParam('page', String(page - 1))}
          >
            Trước
          </Button>
          <span className="text-sm tabular-nums text-[var(--color-muted-foreground)]">
            Trang {meta.page} / {meta.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= meta.totalPages}
            onClick={() => updateParam('page', String(page + 1))}
          >
            Sau
          </Button>
        </nav>
      ) : null}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  options: { value: string; label: string }[];
  placeholder: string;
}) {
  const id = `filter-${label.replace(/\s+/g, '-').toLowerCase()}`;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-medium text-[var(--color-muted-foreground)]">
        {label}
      </label>
      <select
        id={id}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || undefined)}
        className={cn(
          'h-10 w-full rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-3 text-sm',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-ring)]',
        )}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-secondary)] px-3 py-1 text-xs">
      {label}
      <button
        type="button"
        onClick={onClear}
        aria-label={`Bỏ lọc ${label}`}
        className="rounded-full p-0.5 hover:bg-[var(--color-muted)]"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
