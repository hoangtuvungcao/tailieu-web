import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Flag,
  Star,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { BookmarkButton } from '@/components/BookmarkButton';
import { LikeButton } from '@/components/LikeButton';
import { PdfViewer } from '@/components/PdfViewer';
import { ReportDialog } from '@/components/ReportDialog';
import { Badge, Button, Card, CardContent, ErrorState, Skeleton, Spinner } from '@/components/ui';
import { api, ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { useDeleteDocument, useDocument, useDownloadDocument, useRateDocument } from '@/lib/hooks';
import type { DocumentFile } from '@/lib/hooks';
import { useReportState } from '@/lib/report-hooks';
import { useSeo } from '@/lib/seo';
import {
  DOCUMENT_STATUS_LABELS,
  FILE_KIND_LABELS,
  VISIBILITY_LABELS,
  cn,
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
  const { user, isAuthenticated } = useAuth();

  const { data: document, isLoading, isError, error, refetch } = useDocument(id);
  const download = useDownloadDocument();
  const rate = useRateDocument();
  const remove = useDeleteDocument();

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewReason, setPreviewReason] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const [imageError, setImageError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  /** Null means "whatever the server marked primary". */
  const [activeFileId, setActiveFileId] = useState<string | null>(null);

  const [isMobileDevice, setIsMobileDevice] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return (
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
      window.innerWidth < 768
    );
  });
  const [viewerMode, setViewerMode] = useState<'inApp' | 'native'>(() => {
    if (typeof window === 'undefined') return 'inApp';
    const isMob =
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
      window.innerWidth < 768;
    return isMob ? 'inApp' : 'native';
  });

  useEffect(() => {
    const handleResize = () => {
      const mob =
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
        window.innerWidth < 768;
      setIsMobileDevice(mob);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const isOwner = Boolean(user?.id && document?.owner?.id && user.id === document.owner.id);
  const canReport = Boolean(document) && !isOwner;
  const reportState = useReportState('document', id, isAuthenticated && canReport);

  const primaryFile = document?.files?.find((file) => file.isPrimary) ?? document?.files?.[0];
  const activeFile = document?.files?.find((file) => file.id === activeFileId) ?? primaryFile;

  useEffect(() => {
    if (
      activeFile?.previewStatus === 'ready' &&
      (previewReason?.includes('xử lý') || previewReason?.includes('khởi tạo'))
    ) {
      setPreviewReason(null);
    }
  }, [activeFile?.previewStatus, previewReason]);

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


  function selectFile(fileId: string) {
    if (fileId === activeFile?.id) return;
    setActiveFileId(fileId);
    setPreviewUrl(null);
    setPreviewReason(null);
    setTextContent(null);
    setTextError(null);
    setImageError(false);
  }

  async function openPreview(target: DocumentFile) {
    if (!id) return;
    setPreviewLoading(true);
    setPreviewReason(null);
    setImageError(false);
    setTextError(null);
    try {
      const result = await api.get<{ url: string | null; reason: string | null }>(
        `/documents/${id}/preview?fileId=${target.id}`,
      );
      if (result.url) {
        if (target.fileKind === 'pdf' || target.previewStatus === 'ready') {
          // Probe 1 byte to ensure the PDF stream is reachable and does not 500/404
          try {
            const probe = await fetch(result.url, {
              headers: { Range: 'bytes=0-0' },
            });
            if (!probe.ok) {
              setPreviewReason(
                `Không thể tải dữ liệu tệp từ máy chủ lưu trữ (mã lỗi ${probe.status}). Vui lòng tải tệp về máy hoặc thử lại sau.`,
              );
              return;
            }
          } catch {
            setPreviewReason(
              'Không thể kết nối đến máy chủ lưu trữ tệp. Vui lòng kiểm tra lại kết nối mạng.',
            );
            return;
          }
        }

        setPreviewUrl(result.url);
        if (target.fileKind === 'text' || target.fileKind === 'code') {
          setTextLoading(true);
          try {
            const res = await fetch(result.url);
            if (!res.ok) throw new Error('Không thể tải nội dung văn bản.');
            const text = await res.text();
            setTextContent(text);
          } catch (err) {
            setTextError(err instanceof Error ? err.message : 'Lỗi tải văn bản');
          } finally {
            setTextLoading(false);
          }
        }
      } else {
        setPreviewReason(result.reason);
      }
    } catch (err) {
      setPreviewReason(
        err instanceof ApiError && err.message
          ? err.message
          : 'Không thể tải bản xem trước cho tệp này.',
      );
    } finally {
      setPreviewLoading(false);
    }
  }

  async function copyText() {
    if (!textContent) return;
    try {
      await navigator.clipboard.writeText(textContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }

  const canPreviewInline =
    activeFile &&
    (['pdf', 'image', 'text', 'code'].includes(activeFile.fileKind) ||
      activeFile.previewStatus === 'ready');

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
            {previewUrl &&
            (activeFile?.fileKind === 'pdf' || activeFile?.previewStatus === 'ready') ? (
              <div className="space-y-3">
                {!isMobileDevice && (
                  <div className="flex items-center justify-between text-xs text-[var(--color-foreground-muted)] px-1">
                    <span className="font-medium text-[var(--color-foreground)]">
                      Bản xem trước: {activeFile?.originalName}
                    </span>
                    <div className="flex items-center gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)]/30 p-0.5">
                      <button
                        type="button"
                        onClick={() => setViewerMode('native')}
                        className={cn(
                          'rounded-md px-2.5 py-1 font-medium transition-colors cursor-pointer',
                          viewerMode === 'native'
                            ? 'bg-[var(--color-card)] text-[var(--color-foreground)] shadow-xs'
                            : 'text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)]',
                        )}
                      >
                        Khung nhúng gốc
                      </button>
                      <button
                        type="button"
                        onClick={() => setViewerMode('inApp')}
                        className={cn(
                          'rounded-md px-2.5 py-1 font-medium transition-colors cursor-pointer',
                          viewerMode === 'inApp'
                            ? 'bg-[var(--color-card)] text-[var(--color-foreground)] shadow-xs'
                            : 'text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)]',
                        )}
                      >
                        Trình đọc web
                      </button>
                    </div>
                  </div>
                )}

                {isMobileDevice || viewerMode === 'inApp' ? (
                  <PdfViewer
                    url={previewUrl}
                    fileName={activeFile?.originalName}
                    onDownload={() => {
                      if (activeFile) {
                        void download.mutateAsync({
                          documentId: document.id,
                          fileId: activeFile.id,
                        });
                      }
                    }}
                    isDownloading={download.isPending}
                  />
                ) : (
                  <object
                    data={previewUrl}
                    type="application/pdf"
                    className="h-[75vh] w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] shadow-xs"
                    aria-label={`Xem trước ${activeFile?.originalName}`}
                  >
                    <PdfViewer
                      url={previewUrl}
                      fileName={activeFile?.originalName}
                      onDownload={() => {
                        if (activeFile) {
                          void download.mutateAsync({
                            documentId: document.id,
                            fileId: activeFile.id,
                          });
                        }
                      }}
                      isDownloading={download.isPending}
                    />
                  </object>
                )}
              </div>
            ) : previewUrl && activeFile?.fileKind === 'image' ? (
              <div className="flex flex-col items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)]/20 p-4">
                {imageError ? (
                  <div className="p-6 text-center text-sm text-[var(--color-destructive)]">
                    Không tải được hình ảnh xem trước.{' '}
                    <a
                      href={previewUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline font-medium"
                    >
                      Mở trực tiếp
                    </a>
                  </div>
                ) : (
                  <>
                    <img
                      src={previewUrl}
                      alt={activeFile.originalName}
                      className="mx-auto max-h-[70vh] rounded-lg border border-[var(--color-border)] object-contain shadow-sm"
                      onError={() => setImageError(true)}
                    />
                    <div className="mt-3 flex gap-3 text-xs">
                      <a
                        href={previewUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[var(--color-primary)] hover:underline"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Mở ảnh gốc trong tab mới
                      </a>
                    </div>
                  </>
                )}
              </div>
            ) : previewUrl &&
              (activeFile?.fileKind === 'text' || activeFile?.fileKind === 'code') ? (
              <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] shadow-sm">
                <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-muted)]/40 px-4 py-2.5 text-xs text-[var(--color-muted-foreground)]">
                  <div className="flex items-center gap-2 font-mono">
                    <FileText className="h-4 w-4" />
                    <span className="font-medium text-[var(--color-foreground)]">
                      {activeFile.originalName}
                    </span>
                    {textContent !== null ? (
                      <span>({textContent.split('\n').length} dòng)</span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    {textContent !== null ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 px-2 text-xs"
                        onClick={() => void copyText()}
                      >
                        {copied ? (
                          <Check className="h-3.5 w-3.5 text-green-500" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        {copied ? 'Đã sao chép' : 'Sao chép'}
                      </Button>
                    ) : null}
                    <a
                      href={previewUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)]"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Mở raw
                    </a>
                  </div>
                </div>
                {textLoading ? (
                  <div className="flex items-center justify-center p-12">
                    <Spinner className="h-6 w-6" />
                  </div>
                ) : textError ? (
                  <div className="p-8 text-center text-sm text-[var(--color-destructive)]">
                    {textError}
                  </div>
                ) : (
                  <pre className="max-h-[70vh] overflow-auto p-4 font-mono text-xs sm:text-sm leading-relaxed whitespace-pre-wrap break-words bg-[var(--color-muted)]/10">
                    {textContent}
                  </pre>
                )}
              </div>
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
                  <FileText className="h-10 w-10 text-[var(--color-muted-foreground)]" aria-hidden />
                  <p className="text-sm text-[var(--color-muted-foreground)] max-w-md">
                    {previewReason ??
                      (canPreviewInline
                        ? 'Nhấn để xem trước tài liệu ngay trong trình duyệt.'
                        : activeFile?.previewStatus === 'queued' ||
                            activeFile?.previewStatus === 'processing'
                          ? 'Tài liệu đang được xử lý để xem trước. Bạn có thể tải xuống ngay bây giờ.'
                          : 'Định dạng này cần tải xuống để xem. Vui lòng tải tệp về máy.')}
                  </p>
                  {previewReason && activeFile ? (
                    <div className="flex flex-wrap items-center justify-center gap-3 mt-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setPreviewReason(null);
                          void openPreview(activeFile);
                        }}
                        isLoading={previewLoading}
                      >
                        Thử lại
                      </Button>
                      <Button
                        variant="default"
                        size="sm"
                        className="gap-2"
                        onClick={() =>
                          void download.mutateAsync({
                            documentId: document.id,
                            fileId: activeFile.id,
                          })
                        }
                        isLoading={download.isPending}
                      >
                        <Download className="h-4 w-4" />
                        Tải tệp về máy
                      </Button>
                    </div>
                  ) : canPreviewInline && !previewReason && activeFile ? (
                    <Button onClick={() => void openPreview(activeFile)} isLoading={previewLoading}>
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
              {activeFile ? (
                document.files.length === 1 ? (
                  <div className="text-sm">
                    <p className="truncate font-medium" title={activeFile.originalName}>
                      {activeFile.originalName}
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                      {FILE_KIND_LABELS[activeFile.fileKind] ?? activeFile.fileKind} ·{' '}
                      {formatBytes(activeFile.sizeBytes)}
                    </p>
                  </div>
                ) : (
                  /* A document may hold several files. Picking a row is what
                     switches the preview and the main download button, so the
                     rows are buttons rather than plain text. Each carries its
                     own download icon as well, for saving one without first
                     making it the selection. */
                  <div className="text-sm">
                    <p className="font-medium">{document.files.length} tệp đính kèm</p>
                    <ul className="-mx-2 mt-2 space-y-0.5">
                      {document.files.map((file) => {
                        const selected = file.id === activeFile.id;
                        return (
                          <li key={file.id} className="flex items-center gap-0.5">
                            <button
                              type="button"
                              onClick={() => selectFile(file.id)}
                              aria-pressed={selected}
                              className={cn(
                                'min-w-0 flex-1 rounded-md px-2 py-1.5 text-left transition-colors',
                                selected
                                  ? 'bg-[var(--color-muted)]'
                                  : 'hover:bg-[var(--color-muted)]',
                              )}
                            >
                              <span className="flex items-center gap-1.5">
                                <span
                                  className="min-w-0 flex-1 truncate text-xs font-medium"
                                  title={file.originalName}
                                >
                                  {file.originalName}
                                </span>
                                {file.isPrimary ? (
                                  <Badge variant="outline" className="shrink-0">
                                    Chính
                                  </Badge>
                                ) : null}
                              </span>
                              <span className="mt-0.5 block text-[11px] text-[var(--color-muted-foreground)]">
                                {FILE_KIND_LABELS[file.fileKind] ?? file.fileKind} ·{' '}
                                {formatBytes(file.sizeBytes)}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                void download.mutateAsync({ documentId: document.id, fileId: file.id })
                              }
                              aria-label={`Tải xuống ${file.originalName}`}
                              className="shrink-0 rounded p-1.5 text-[var(--color-muted-foreground)] transition-colors hover:text-[var(--color-primary)]"
                            >
                              <Download className="h-3.5 w-3.5" aria-hidden />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )
              ) : null}

              <Button
                className="w-full gap-2"
                onClick={() =>
                  void download.mutateAsync({ documentId: document.id, fileId: activeFile?.id })
                }
                isLoading={download.isPending}
                disabled={!activeFile}
              >
                <Download className="h-4 w-4" />
                {document.files.length > 1 ? 'Tải tệp đang chọn' : 'Tải xuống'}
              </Button>

              <div className="flex gap-2">
                <BookmarkButton
                  target="document"
                  id={document.id}
                  className="flex-1 justify-center border border-[var(--color-border)]"
                />
                <LikeButton
                  documentId={document.id}
                  className="flex-1 justify-center border border-[var(--color-border)]"
                />
              </div>

              {isOwner ? (
                <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] px-3 py-2 text-center text-xs text-[var(--color-muted-foreground)]">
                  Đây là tài liệu do bạn đăng tải
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full gap-2 border-[var(--color-destructive)]/30 text-[var(--color-destructive)] hover:bg-[color-mix(in_oklch,var(--color-destructive)_8%,transparent)]"
                  disabled={reportState.data?.reported}
                  onClick={() => {
                    if (!isAuthenticated) {
                      navigate('/login');
                    } else {
                      setReportOpen(true);
                    }
                  }}
                >
                  <Flag className="h-4 w-4" />
                  {reportState.data?.reported ? 'Đã báo cáo vi phạm' : 'Báo cáo tài liệu vi phạm'}
                </Button>
              )}

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

      {reportOpen && document ? (
        <ReportDialog
          targetType="document"
          targetId={document.id}
          targetTitle={document.title}
          onClose={() => setReportOpen(false)}
        />
      ) : null}
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
