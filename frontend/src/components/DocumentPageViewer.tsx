import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Maximize2,
  Minimize2,
  RotateCw,
  ZoomIn,
  ZoomOut,
  LayoutGrid,
  Zap,
  Loader2,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import { Button } from './ui';
import { cn } from '../lib/utils';

export interface DocumentPageViewerProps {
  pages: string[];
  totalPages?: number;
  fileName?: string;
  pdfUrl?: string | null;
  className?: string;
  onDownload?: () => void;
  isDownloading?: boolean;
  onSwitchToPdf?: () => void;
}

export function DocumentPageViewer({
  pages,
  totalPages,
  fileName,
  pdfUrl,
  className = '',
  onDownload,
  isDownloading = false,
  onSwitchToPdf,
}: DocumentPageViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const total = totalPages || pages.length;

  const [currentPage, setCurrentPage] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.0);
  const [rotation, setRotation] = useState<number>(0);
  const [fitWidth, setFitWidth] = useState<boolean>(true);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [isImageLoading, setIsImageLoading] = useState<boolean>(true);
  const [imageError, setImageError] = useState<boolean>(false);
  const [showThumbnails, setShowThumbnails] = useState<boolean>(false);
  const [pageInput, setPageInput] = useState<string>('1');
  const retryCountRef = useRef<number>(0);

  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  // Sync page input when currentPage changes
  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  // Smart Preload: eagerly prefetch next and previous pages for instant 0ms flip
  useEffect(() => {
    if (pages[currentPage]) {
      // next page (currentPage is 1-indexed, so pages[currentPage] is next)
      const nextImg = new Image();
      nextImg.src = pages[currentPage];
    }
    if (currentPage > 1 && pages[currentPage - 2]) {
      // prev page
      const prevImg = new Image();
      prevImg.src = pages[currentPage - 2];
    }
  }, [currentPage, pages]);

  // Page Navigation Handlers
  const goToPage = useCallback(
    (page: number) => {
      const target = Math.max(1, Math.min(page, total));
      if (target !== currentPage) {
        setIsImageLoading(true);
        setImageError(false);
        setCurrentPage(target);
      }
    },
    [currentPage, total],
  );

  const nextPage = useCallback(() => {
    goToPage(currentPage + 1);
  }, [currentPage, goToPage]);

  const prevPage = useCallback(() => {
    goToPage(currentPage - 1);
  }, [currentPage, goToPage]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        nextPage();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        prevPage();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nextPage, prevPage]);

  // Fullscreen toggle
  const toggleFullscreen = useCallback(async () => {
    if (!containerRef.current) return;
    try {
      if (!document.fullscreenElement) {
        await containerRef.current.requestFullscreen();
        setIsFullscreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullscreen(false);
      }
    } catch {
      // Ignore fullscreen permission rejections
    }
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Touch Swipe Handlers for mobile
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      touchStartRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
      };
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStartRef.current || e.changedTouches.length === 0) return;
    const deltaX = e.changedTouches[0].clientX - touchStartRef.current.x;
    const deltaY = e.changedTouches[0].clientY - touchStartRef.current.y;
    touchStartRef.current = null;

    // Trigger swipe only if horizontal delta is significant and dominant
    if (Math.abs(deltaX) > 48 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
      if (deltaX < 0) {
        nextPage();
      } else {
        prevPage();
      }
    }
  };

  const handlePageInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseInt(pageInput, 10);
    if (!isNaN(parsed) && parsed >= 1 && parsed <= total) {
      goToPage(parsed);
    } else {
      setPageInput(String(currentPage));
    }
  };

  const currentImageUrl = pages[currentPage - 1];

  return (
    <div
      ref={containerRef}
      className={cn(
        'group relative flex flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] shadow-xs transition-colors',
        isFullscreen ? 'fixed inset-0 z-50 h-screen w-screen rounded-none' : 'w-full',
        className,
      )}
    >
      {/* --- Top Control Bar ------------------------------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-card)]/90 backdrop-blur-md px-3 py-2 text-xs sm:px-4">
        {/* Left: Navigation & Speed Badge */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          <div className="flex items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)]/40 p-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md cursor-pointer disabled:opacity-30"
              onClick={prevPage}
              disabled={currentPage <= 1}
              title="Trang trước (Phím mũi tên Trái)"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>

            <form onSubmit={handlePageInputSubmit} className="flex items-center px-1">
              <input
                type="text"
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value)}
                onBlur={handlePageInputSubmit}
                className="h-6 w-9 rounded border border-transparent bg-transparent text-center font-semibold text-[var(--color-foreground)] outline-none transition-colors hover:border-[var(--color-border)] focus:border-[var(--color-primary)] focus:bg-[var(--color-background)]"
                aria-label="Số trang hiện tại"
              />
              <span className="text-[var(--color-foreground-muted)] select-none">/ {total}</span>
            </form>

            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md cursor-pointer disabled:opacity-30"
              onClick={nextPage}
              disabled={currentPage >= total}
              title="Trang tiếp (Phím mũi tên Phải)"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          {/* High speed badge */}
          <div
            className="hidden items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 sm:inline-flex"
            title="Được nén tối ưu ~40KB/trang, tải tức thì không tốn dung lượng 4G"
          >
            <Zap className="h-3 w-3 fill-current" />
            <span>Siêu tốc (~40KB)</span>
          </div>

          {/* Thumbnails drawer toggle */}
          {total > 1 && (
            <Button
              variant={showThumbnails ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 gap-1 px-2 text-xs cursor-pointer"
              onClick={() => setShowThumbnails(!showThumbnails)}
              title="Xem danh sách trang thu nhỏ"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Mục lục</span>
            </Button>
          )}
        </div>

        {/* Right: Zoom, Fullscreen, PDF fallback & Download */}
        <div className="flex items-center gap-1 sm:gap-1.5">
          {/* Zoom controls */}
          <div className="hidden items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)]/40 p-0.5 md:flex">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md cursor-pointer disabled:opacity-30"
              onClick={() => {
                setFitWidth(false);
                setScale((s) => Math.max(0.5, s - 0.2));
              }}
              disabled={scale <= 0.6 && !fitWidth}
              title="Thu nhỏ"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>

            <button
              type="button"
              onClick={() => {
                setFitWidth(!fitWidth);
                setScale(1.0);
              }}
              className="px-2 py-0.5 text-[11px] font-medium text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] transition-colors cursor-pointer"
              title="Chuyển chế độ vừa khung hoặc 100%"
            >
              {fitWidth ? 'Vừa trang' : `${Math.round(scale * 100)}%`}
            </button>

            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md cursor-pointer disabled:opacity-30"
              onClick={() => {
                setFitWidth(false);
                setScale((s) => Math.min(2.5, s + 0.2));
              }}
              disabled={scale >= 2.4}
              title="Phóng to"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md cursor-pointer"
              onClick={() => setRotation((r) => (r + 90) % 360)}
              title="Xoay trang"
            >
              <RotateCw className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* Switch to native PDF mode */}
          {onSwitchToPdf && pdfUrl && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onSwitchToPdf}
              className="h-7 gap-1 px-2 text-xs font-normal text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] cursor-pointer"
              title="Chuyển sang chế độ xem tệp PDF gốc để chọn/sao chép văn bản"
            >
              <FileText className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Bản PDF gốc</span>
            </Button>
          )}

          {/* Fullscreen */}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 cursor-pointer"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Thu nhỏ' : 'Toàn màn hình'}
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>

          {/* Download button */}
          {onDownload && (
            <Button
              variant="default"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-xs font-medium cursor-pointer"
              onClick={onDownload}
              disabled={isDownloading}
            >
              {isDownloading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">Tải về</span>
            </Button>
          )}
        </div>
      </div>

      {/* --- Main Viewing Area ----------------------------------------------- */}
      <div className="relative flex flex-1 overflow-hidden">
        {/* Thumbnails Sidebar / Drawer */}
        {showThumbnails && (
          <aside className="w-28 shrink-0 overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-muted)]/20 p-2 sm:w-36">
            <div className="space-y-2">
              {pages.map((thumbUrl, idx) => {
                const pageNum = idx + 1;
                const isSelected = pageNum === currentPage;
                return (
                  <button
                    key={pageNum}
                    type="button"
                    onClick={() => goToPage(pageNum)}
                    className={cn(
                      'group relative flex w-full flex-col items-center rounded-lg border p-1 text-center transition-all cursor-pointer',
                      isSelected
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 shadow-xs'
                        : 'border-[var(--color-border)] bg-[var(--color-card)] hover:border-[var(--color-foreground-muted)]',
                    )}
                  >
                    <img
                      src={thumbUrl}
                      alt={`Trang ${pageNum}`}
                      loading="lazy"
                      className="aspect-[1/1.4] w-full rounded object-contain bg-white shadow-2xs"
                    />
                    <span
                      className={cn(
                        'mt-1 text-[11px] font-medium',
                        isSelected
                          ? 'text-[var(--color-primary)] font-bold'
                          : 'text-[var(--color-foreground-muted)]',
                      )}
                    >
                      Trang {pageNum}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>
        )}

        {/* Page Render Canvas */}
        <main
          className="relative flex flex-1 items-center justify-center overflow-auto bg-[var(--color-muted)]/15 p-2 sm:p-4 select-none min-h-[50vh] max-h-[82vh]"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {/* Skeleton shimmer while loading */}
          {isImageLoading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-[var(--color-card)]/50 backdrop-blur-2xs">
              <Loader2 className="h-8 w-8 animate-spin text-[var(--color-primary)]" />
              <span className="mt-2 text-xs font-medium text-[var(--color-foreground-muted)]">
                Đang tải trang {currentPage}...
              </span>
            </div>
          )}

          {/* Error fallback */}
          {imageError ? (
            <div className="flex flex-col items-center justify-center p-8 text-center text-sm">
              <AlertCircle className="h-10 w-10 text-[var(--color-destructive)] mb-2" />
              <p className="font-semibold text-[var(--color-foreground)]">
                Không thể tải hình ảnh trang {currentPage}
              </p>
              <p className="mt-1 text-xs text-[var(--color-foreground-muted)]">
                Vui lòng thử lại hoặc chuyển sang xem bản PDF gốc.
              </p>
              <div className="mt-4 flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    retryCountRef.current = 0;
                    setImageError(false);
                    setIsImageLoading(true);
                  }}
                  className="gap-1 text-xs cursor-pointer"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Thử lại
                </Button>
                {onSwitchToPdf && (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={onSwitchToPdf}
                    className="text-xs cursor-pointer"
                  >
                    Xem bản PDF gốc
                  </Button>
                )}
              </div>
            </div>
          ) : currentImageUrl ? (
            <div
              className="relative transition-transform duration-200 ease-out flex items-center justify-center"
              style={{
                transform: `rotate(${rotation}deg) scale(${fitWidth ? 1 : scale})`,
                maxWidth: fitWidth ? '100%' : undefined,
              }}
            >
              <img
                key={currentImageUrl}
                src={currentImageUrl}
                alt={`${fileName || 'Tài liệu'} - Trang ${currentPage}`}
                onLoad={() => setIsImageLoading(false)}
                onError={() => {
                  if (currentPage === 1 && retryCountRef.current < 2) {
                    retryCountRef.current += 1;
                    setTimeout(() => {
                      setIsImageLoading(true);
                      setImageError(false);
                    }, 1200);
                  } else {
                    setIsImageLoading(false);
                    setImageError(true);
                    if (currentPage === 1 && onSwitchToPdf) {
                      onSwitchToPdf();
                    }
                  }
                }}
                className={cn(
                  'rounded-lg bg-white shadow-md transition-opacity duration-150',
                  fitWidth
                    ? 'max-h-[78vh] w-auto max-w-full object-contain'
                    : 'max-w-none shadow-lg',
                  isImageLoading ? 'opacity-0' : 'opacity-100',
                )}
                draggable={false}
              />
            </div>
          ) : null}
        </main>
      </div>

      {/* --- Bottom Mobile Bar ----------------------------------------------- */}
      <div className="flex items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-card)]/90 px-3 py-1.5 text-xs text-[var(--color-foreground-muted)] sm:hidden">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs cursor-pointer"
          onClick={prevPage}
          disabled={currentPage <= 1}
        >
          <ChevronLeft className="mr-0.5 h-3.5 w-3.5" />
          Trước
        </Button>

        <span className="text-[11px] font-medium">
          Trang {currentPage} / {total}
        </span>

        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs cursor-pointer"
          onClick={nextPage}
          disabled={currentPage >= total}
        >
          Tiếp
          <ChevronRight className="ml-0.5 h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
