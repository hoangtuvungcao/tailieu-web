import {
  Download,
  Eye,
  FileArchive,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  Presentation,
  Star,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import { Badge } from '@/components/ui';
import type { DocumentSummary } from '@/lib/hooks';
import {
  DOCUMENT_STATUS_LABELS,
  FILE_KIND_LABELS,
  cn,
  formatBytes,
  formatRelativeTime,
  parseHighlight,
} from '@/lib/utils';

/**
 * Document card.
 *
 * The highlight rendering is the part worth being careful about. The API
 * returns titles with matched terms wrapped in U+0002/U+0003, and the segments
 * are rendered as React text nodes — never with `dangerouslySetInnerHTML`. A
 * document titled `<script>alert(1)</script>` is legal input; injecting it as
 * HTML on a search results page would be stored XSS on the site's own origin.
 */

const KIND_ICONS: Record<string, typeof FileText> = {
  pdf: FileType2,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  archive: FileArchive,
  image: FileImage,
  code: FileCode2,
};

export function HighlightedText({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const segments = parseHighlight(value);

  return (
    <span className={className}>
      {segments.map((segment, index) =>
        segment.matched ? (
          <mark
            // Index is a stable key here: the segment list is derived purely
            // from the string and never reordered.
            key={index}
            className="rounded-sm bg-[var(--color-gold-200)] px-0.5 text-[var(--color-gold-700)]"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </span>
  );
}

export function DocumentCard({
  document,
  highlightTitle,
  className,
}: {
  document: DocumentSummary;
  /** Pre-highlighted title from a search hit. Falls back to the plain title. */
  highlightTitle?: string;
  className?: string;
}) {
  const Icon = KIND_ICONS[document.fileKind ?? 'other'] ?? FileText;
  const rating = document.stats.ratingAverage;

  return (
    <article
      className={cn(
        'group flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4',
        'transition-shadow hover:[box-shadow:var(--shadow-lifted)]',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[var(--color-brand-50)] text-[var(--color-brand-700)]"
        >
          <Icon className="h-5 w-5" />
        </span>

        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold leading-snug">
            <Link
              to={`/documents/${document.id}`}
              className="hover:text-[var(--color-primary)] hover:underline"
            >
              {highlightTitle ? (
                <HighlightedText value={highlightTitle} />
              ) : (
                document.title
              )}
            </Link>
          </h3>

          <p className="mt-0.5 truncate text-xs text-[var(--color-muted-foreground)]">
            {[
              document.taxonomy.faculty?.name,
              document.taxonomy.subject?.name,
              document.taxonomy.documentType?.name,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>

        {/* Status is only shown when it is NOT published. A "Đã đăng" badge on
            every card is noise; an unseen "Chờ kiểm duyệt" is a surprise. */}
        {document.status !== 'published' ? (
          <Badge
            variant={document.status === 'rejected' ? 'destructive' : 'warning'}
            className="shrink-0"
          >
            {DOCUMENT_STATUS_LABELS[document.status] ?? document.status}
          </Badge>
        ) : null}
      </div>

      {document.description ? (
        <p className="line-clamp-2 text-xs text-[var(--color-muted-foreground)]">
          {document.description}
        </p>
      ) : null}

      {document.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {document.tags.slice(0, 4).map((tag) => (
            <Badge key={tag.id} variant="outline" className="text-[11px]">
              {tag.name}
            </Badge>
          ))}
        </div>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-muted-foreground)]">
        <span className="inline-flex items-center gap-1">
          <Download className="h-3 w-3" aria-hidden />
          {document.stats.downloads}
        </span>
        <span className="inline-flex items-center gap-1">
          <Eye className="h-3 w-3" aria-hidden />
          {document.stats.views}
        </span>
        {rating !== null ? (
          <span className="inline-flex items-center gap-1">
            <Star className="h-3 w-3 fill-[var(--color-gold-400)] text-[var(--color-gold-400)]" aria-hidden />
            {rating.toFixed(1)}
            <span className="sr-only">trên 5, {document.stats.ratingCount} lượt đánh giá</span>
          </span>
        ) : null}
        <span>{FILE_KIND_LABELS[document.fileKind ?? 'other'] ?? 'Khác'}</span>
        {document.sizeBytes ? <span>{formatBytes(document.sizeBytes)}</span> : null}
        <span className="ml-auto">{formatRelativeTime(document.createdAt)}</span>
      </div>
    </article>
  );
}

/** Loading placeholder with the same shape as the real card. */
export function DocumentCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] p-4">
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 shrink-0 animate-pulse rounded-md bg-[var(--color-muted)]" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-3/4 animate-pulse rounded bg-[var(--color-muted)]" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-[var(--color-muted)]" />
        </div>
      </div>
      <div className="h-3 w-full animate-pulse rounded bg-[var(--color-muted)]" />
      <div className="h-3 w-2/3 animate-pulse rounded bg-[var(--color-muted)]" />
    </div>
  );
}
