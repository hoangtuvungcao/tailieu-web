import {
  ArrowLeft,
  Download,
  Eye,
  FileText,
  Star,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { BookmarkButton } from '@/components/BookmarkButton';
import { Badge, Button, Card, CardContent, ErrorState, Skeleton, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { useDeleteDocument, useDocument, useDownloadDocument, useRateDocument } from '@/lib/hooks';
import { useSeo } from '@/lib/seo';
import {
  DOCUMENT_STATUS_LABELS,
  FILE_KIND_LABELS,
  VISIBILITY_LABELS,
  formatBytes,
  formatDate,
  formatRelativeTime,
} from '@/lib/utils';

/**
 * Document detail.
 *
 * Preview strategy: PDFs and images render inline via the browser, using a
 * signed URL fetched on demand. Office formats show a download prompt until the
 * conversion worker produces a PDF — the UI reads `previewStatus` rather than
 * guessing from the file type, so it stays correct once conversion lands.
 *
 * The signed URL is fetched only when the user opens the preview, not on page
 * load. Minting one per page view would consume a URL that expires in two
 * minutes regardless of whether anyone looked.
 */
export function DocumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  const { data: document, isLoading, isError, error, refetch } = useDocument(id);
  const download = useDownloadDocument();
  const rate = useRateDocument();
  const remove = useDeleteDocument();

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewReason, setPreviewReason] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // A shared document link is the one URL on this site that people paste into
  // chat, so its preview matters more here than anywhere else: the title, the
  // description the uploader wrote, and `article` so the card renders as
  // content. The values are absent while the request is in flight, and the
  // route default covers that window.
  useSeo({
    title: document ? `${document.title} — TAILIEU TTN` : 'Tài liệu — TAILIEU TTN',
    description: document?.description ?? undefined,
    type: 'article',
    jsonLd: document
      ? {
          '@context': 'https://schema.org',
          '@type': 'LearningResource',
          name: document.title,
          description: document.description ?? undefined,
          inLanguage: document.language,
          datePublished: document.publishedAt ?? document.createdAt,
          educationalLevel: document.taxonomy.academicYear?.name ?? undefined,
          about: document.taxonomy.subject?.name ?? undefined,
          learningResourceType: document.taxonomy.documentType?.name ?? undefined,
          provider: { '@type': 'CollegeOrUniversity', name: 'Đại học Tây Nguyên' },
          // Interaction counts, not ratings: `ratingAverage` is null until
          // somebody rates, and emitting `aggregateRating` with no ratings is
          // the kind of markup that gets a site penalised.
          interactionStatistic: [
            { '@type': 'InteractionCounter', interactionType: 'https://schema.org/DownloadAction', userInteractionCount: document.stats.downloads },
            { '@type': 'InteractionCounter', interactionType: 'https://schema.org/LikeAction', userInteractionCount: document.stats.likes },
          ],
        }
      : null,
  });

  if (isLoading) {
    return (
      <div className="container-page space-y-4 py-8">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !document) {
    return (
      <div className="container-page py-16">
        <ErrorState
          message={
            error instanceof ApiError && error.status === 404
              ? 'Không tìm thấy tài liệu. Có thể nó đã bị xoá, hoặc bạn không có quyền xem.'
              : 'Không tải được tài liệu.'
          }
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const primaryFile = document.files.find((file) => file.isPrimary) ?? document.files[0];

  async function openPreview() {
    if (!id || !primaryFile) return;
    setPreviewLoading(true);
    try {
      // The PREVIEW endpoint, not download.
      //
      // The two mint the same token over the same bytes and differ in exactly
      // one thing: `mode`, which becomes `Content-Disposition`. Download sends
      // `attachment`, and a browser handed an attachment saves the file instead
      // of rendering it — so an `<object>` given a download URL displays
      // nothing. That is what this did, which is why the preview pane stayed
      // empty for the format the preview pane exists for.
      const result = await api.get<{ url: string | null; reason: string | null }>(
        `/documents/${id}/preview?fileId=${primaryFile.id}`,
      );
      if (result.url) {
        setPreviewUrl(result.url);
      } else {
        // The server knows why there is nothing to show — still converting, or
        // a format with no viewer. It says so in Vietnamese; repeating that
        // beats inventing a second explanation here that can drift from it.
        setPreviewReason(result.reason);
      }
    } catch {
      // Leave the preview closed; the download button is still available.
    } finally {
      setPreviewLoading(false);
    }
  }

  const canPreviewInline = primaryFile && ['pdf', 'image', 'text', 'code'].includes(primaryFile.fileKind);

  return (
    <div className="container-page py-8">
      <Button variant="ghost" size="sm" className="mb-4 gap-2" onClick={() => navigate(-1)}>
        <ArrowLeft className="h-4 w-4" />
        Quay lại
      </Button>

      <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
        {/* --- Main --------------------------------------------------------- */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="brand">
              {document.taxonomy.documentType?.name ?? 'Tài liệu'}
            </Badge>
            {document.status !== 'published' ? (
              <Badge variant={document.status === 'rejected' ? 'destructive' : 'warning'}>
                {DOCUMENT_STATUS_LABELS[document.status] ?? document.status}
              </Badge>
            ) : null}
            {document.visibility !== 'public' ? (
              <Badge variant="outline">
                {VISIBILITY_LABELS[document.visibility] ?? document.visibility}
              </Badge>
            ) : null}
          </div>

          {/* Rendered as a text node. A title is user input, and the API does
              not sanitise it into markup — neither should this. */}
          <h1 className="mt-3 text-2xl font-bold tracking-tight">{document.title}</h1>

          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--color-muted-foreground)]">
            {document.owner ? (
              <Link
                to={`/users/${document.owner.id}`}
                className="hover:text-[var(--color-primary)]"
              >
                {document.owner.displayName}
              </Link>
            ) : (
              <span>Ẩn danh</span>
            )}
            <span aria-hidden>·</span>
            <span>{formatRelativeTime(document.createdAt)}</span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              <Download className="h-3.5 w-3.5" aria-hidden />
              {document.stats.downloads}
            </span>
            <span className="inline-flex items-center gap-1">
              <Eye className="h-3.5 w-3.5" aria-hidden />
              {document.stats.views}
            </span>
          </p>

          {document.description ? (
            <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed">
              {document.description}
            </p>
          ) : null}

          {/* --- Preview ---------------------------------------------------- */}
          <div className="mt-6">
            {previewUrl && primaryFile?.fileKind === 'pdf' ? (
              <object
                data={previewUrl}
                type="application/pdf"
                className="h-[70vh] w-full rounded-lg border border-[var(--color-border)]"
                aria-label={`Xem trước ${primaryFile.originalName}`}
              >
                <p className="p-4 text-sm">
                  Trình duyệt không hiển thị được PDF trực tiếp.{' '}
                  <a href={previewUrl} className="text-[var(--color-primary)] underline">
                    Mở trong tab mới
                  </a>
                </p>
              </object>
            ) : previewUrl && primaryFile?.fileKind === 'image' ? (
              <img
                src={previewUrl}
                alt={primaryFile.originalName}
                className="mx-auto max-h-[70vh] rounded-lg border border-[var(--color-border)]"
              />
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
                  <FileText className="h-10 w-10 text-[var(--color-muted-foreground)]" aria-hidden />
                  <p className="text-sm text-[var(--color-muted-foreground)]">
                    {previewReason ??
                      (canPreviewInline
                        ? 'Nhấn để xem trước tài liệu ngay trong trình duyệt.'
                        : primaryFile?.previewStatus === 'queued' ||
                            primaryFile?.previewStatus === 'processing'
                          ? 'Tài liệu đang được xử lý để xem trước. Bạn có thể tải xuống ngay bây giờ.'
                          : 'Định dạng này cần tải xuống để xem. Vui lòng tải tệp về máy.')}
                  </p>
                  {canPreviewInline && !previewReason ? (
                    <Button onClick={() => void openPreview()} isLoading={previewLoading}>
                      Xem trước
                    </Button>
                  ) : null}
                </CardContent>
              </Card>
            )}
          </div>
        </div>

        {/* --- Sidebar ------------------------------------------------------ */}
        {/*
          `min-w-0` is load-bearing, not tidiness. This is a grid item, and a
          grid item defaults to `min-width: auto`, which resolves to its
          content-based minimum — and the filename below is `truncate`, so its
          min-content width is the whole filename, unwrapped. The single-column
          grid track is `auto` and sizes to the largest minimum contribution, so
          one long filename pushed the column to ~520px inside a 360px phone.
          Both grid items stretched to that width, the heading wrapped at 520px
          and painted off-screen, and the page scrolled sideways.

          The `min-w-0` already on the main column does not help: it lowers that
          item's own contribution, but the track was already being held open by
          this one. Truncation only works once the box is allowed to be narrower
          than the text it is truncating.
        */}
        <aside className="min-w-0 space-y-4">
          <Card>
            <CardContent className="space-y-3 p-5">
              {primaryFile ? (
                <div className="text-sm">
                  <p className="truncate font-medium" title={primaryFile.originalName}>
                    {primaryFile.originalName}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                    {FILE_KIND_LABELS[primaryFile.fileKind] ?? primaryFile.fileKind} ·{' '}
                    {formatBytes(primaryFile.sizeBytes)}
                  </p>
                </div>
              ) : null}

              <Button
                className="w-full gap-2"
                onClick={() => void download.mutateAsync(document.id)}
                isLoading={download.isPending}
                disabled={!primaryFile}
              >
                <Download className="h-4 w-4" />
                Tải xuống
              </Button>

              <BookmarkButton
                target="document"
                id={document.id}
                className="w-full justify-center border border-[var(--color-border)]"
              />

              {download.isError ? (
                <p role="alert" className="text-xs text-[var(--color-destructive)]">
                  {download.error instanceof ApiError
                    ? download.error.message
                    : 'Tải xuống thất bại.'}
                </p>
              ) : null}
            </CardContent>
          </Card>

          {/* --- Rating ------------------------------------------------------ */}
          {isAuthenticated ? (
            <Card>
              <CardContent className="space-y-2 p-5">
                <p className="text-sm font-medium">Đánh giá tài liệu</p>
                <div className="flex items-center gap-1">
                  {[1, 2, 3, 4, 5].map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => void rate.mutateAsync({ documentId: document.id, rating: value })}
                      disabled={rate.isPending}
                      aria-label={`Đánh giá ${value} sao`}
                      className="rounded p-0.5 hover:scale-110 disabled:opacity-50"
                    >
                      <Star
                        className={
                          document.stats.ratingAverage !== null &&
                          value <= Math.round(document.stats.ratingAverage)
                            ? 'h-5 w-5 fill-[var(--color-gold-400)] text-[var(--color-gold-400)]'
                            : 'h-5 w-5 text-[var(--color-muted-foreground)]'
                        }
                      />
                    </button>
                  ))}
                </div>
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  {document.stats.ratingAverage !== null
                    ? `${document.stats.ratingAverage.toFixed(1)}/5 · ${document.stats.ratingCount} lượt`
                    : 'Chưa có đánh giá'}
                </p>
                {rate.isError ? (
                  <p role="alert" className="text-xs text-[var(--color-destructive)]">
                    {rate.error instanceof ApiError ? rate.error.message : 'Không thể đánh giá.'}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {/* --- Metadata ---------------------------------------------------- */}
          <Card>
            <CardContent className="space-y-2 p-5 text-sm">
              <MetaRow label="Khoa" value={document.taxonomy.faculty?.name} />
              <MetaRow label="Ngành" value={document.taxonomy.program?.name} />
              <MetaRow label="Học phần" value={document.taxonomy.subject?.name} />
              <MetaRow label="Học kỳ" value={document.taxonomy.semester?.name} />
              <MetaRow label="Năm học" value={document.taxonomy.academicYear?.name} />
              <MetaRow label="Ngày đăng" value={formatDate(document.publishedAt ?? document.createdAt)} />
            </CardContent>
          </Card>

          {document.tags.length > 0 ? (
            <Card>
              <CardContent className="p-5">
                <p className="mb-2 text-sm font-medium">Thẻ</p>
                <div className="flex flex-wrap gap-1">
                  {document.tags.map((tag) => (
                    <Link key={tag.id} to={`/documents?tag=${encodeURIComponent(tag.slug)}`}>
                      <Badge variant="outline">{tag.name}</Badge>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}

          {/* --- Owner actions ----------------------------------------------- */}
          {document.permissions?.canDelete ? (
            <Card>
              <CardContent className="space-y-2 p-5">
                {confirmDelete ? (
                  <>
                    <p className="flex items-start gap-2 text-xs text-[var(--color-muted-foreground)]">
                      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                      Tài liệu sẽ bị ẩn khỏi mọi người. Hành động này không thể hoàn tác từ giao diện.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="destructive"
                        size="sm"
                        className="flex-1"
                        isLoading={remove.isPending}
                        onClick={async () => {
                          await remove.mutateAsync(document.id);
                          navigate('/documents', { replace: true });
                        }}
                      >
                        Xác nhận xoá
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                        Huỷ
                      </Button>
                    </div>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full gap-2 text-[var(--color-destructive)]"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="h-4 w-4" />
                    Xoá tài liệu
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-3">
      <span className="shrink-0 text-[var(--color-muted-foreground)]">{label}</span>
      <span className="truncate text-right" title={value}>
        {value}
      </span>
    </div>
  );
}

/** Kept for the loading state used by the router-level suspense boundary. */
export function DocumentDetailFallback() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <Spinner className="h-6 w-6" />
    </div>
  );
}
