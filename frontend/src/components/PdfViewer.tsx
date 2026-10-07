import { useCallback, useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Maximize2,
  Minimize2,
  RotateCw,
  ZoomIn,
  ZoomOut,
  Loader2,
  AlertCircle,
  FileText,
} from 'lucide-react';
import { Button } from './ui';

// Configure the worker source for Vite
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

interface PdfViewerProps {
  url: string;
  fileName?: string;
  className?: string;
  onDownload?: () => void;
  isDownloading?: boolean;
}

export function PdfViewer({
  url,
  fileName,
  className = '',
  onDownload,
  isDownloading = false,
}: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [numPages, setNumPages] = useState<number>(0);
  const [scale, setScale] = useState<number>(1.0);
  const [rotation, setRotation] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [pageRendering, setPageRendering] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  // Load Document
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorMessage(null);
    setCurrentPage(1);

    const localOrigin = typeof window !== 'undefined' ? window.location.origin : '';
    const loadingTask = pdfjsLib.getDocument({
      url,
      cMapUrl: `${localOrigin}/pdfjs/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${localOrigin}/pdfjs/standard_fonts/`,
      enableXfa: true,
      disableAutoFetch: true,
      disableStream: false,
      // 512KB chunk size (524288) provides fast initial page fetch while avoiding dozens of 128KB roundtrips
      rangeChunkSize: 524288,
    });

    loadingTask.promise
      .then((doc) => {
        if (cancelled) {
          void doc.destroy();
          return;
        }
        setPdfDoc(doc);
        setNumPages(doc.numPages);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : 'Không thể mở tài liệu PDF.';
        setErrorMessage(msg);
        setLoading(false);
      });

    return () => {
      cancelled = true;
      void loadingTask.destroy();
    };
  }, [url]);

  // Render Page
  const renderPage = useCallback(
    async (pageNum: number) => {
      if (!pdfDoc || !canvasRef.current || !containerRef.current) return;

      // Cancel previous render task if still in flight
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {
          // Ignore cancellation errors
        }
        renderTaskRef.current = null;
      }

      setPageRendering(true);

      try {
        const page = await pdfDoc.getPage(pageNum);
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Calculate responsive scale based on container width
        const availableWidth = Math.max(containerRef.current.clientWidth - 24, 280);
        const unscaledViewport = page.getViewport({ scale: 1, rotation });
        
        // Base scale that fits the screen width nicely
        const fitScale = unscaledViewport.width > 0 ? (availableWidth / unscaledViewport.width) : 1;
        const effectiveScale = fitScale * scale;

        const viewport = page.getViewport({ scale: effectiveScale, rotation });

        // Handle high DPI (Retina/mobile) displays capped at 2.0 to save memory and render fast
        const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2.0));
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        const renderContext = {
          canvasContext: ctx,
          viewport,
        };

        const task = page.render(renderContext);
        renderTaskRef.current = task;

        await task.promise;
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'RenderingCancelledException') {
          // Expected when rapidly navigating
          return;
        }
        console.error('Lỗi kết xuất trang PDF:', err);
      } finally {
        setPageRendering(false);
      }
    },
    [pdfDoc, scale, rotation],
  );

  useEffect(() => {
    if (pdfDoc && currentPage >= 1 && currentPage <= numPages) {
      void renderPage(currentPage);
    }
  }, [pdfDoc, currentPage, renderPage, numPages]);

  // Preload next page ONLY when active page is done rendering and viewer is idle
  // This prevents background preload requests from competing with and delaying the active page
  useEffect(() => {
    if (!pdfDoc || numPages <= 1 || loading || pageRendering) return;
    const nextPage = currentPage + 1;
    if (nextPage > numPages) return;

    const timer = setTimeout(() => {
      void pdfDoc.getPage(nextPage).catch(() => undefined);
    }, 800);

    return () => clearTimeout(timer);
  }, [pdfDoc, currentPage, numPages, loading, pageRendering]);

  // Responsive re-render on window resize / orientation change
  useEffect(() => {
    let timeoutId: number | undefined;
    const handleResize = () => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        if (pdfDoc && currentPage >= 1) {
          void renderPage(currentPage);
        }
      }, 150);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener('resize', handleResize);
    };
  }, [pdfDoc, currentPage, renderPage]);

  // Fullscreen change listener
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      void containerRef.current.requestFullscreen?.().catch(() => undefined);
    } else {
      void document.exitFullscreen?.().catch(() => undefined);
    }
  };

  const goToPrevPage = useCallback(() => {
    setCurrentPage((p) => Math.max(p - 1, 1));
  }, []);

  const goToNextPage = useCallback(() => {
    if (numPages > 0) {
      setCurrentPage((p) => Math.min(p + 1, numPages));
    }
  }, [numPages]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        goToPrevPage();
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        goToNextPage();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goToPrevPage, goToNextPage]);

  // Touch swipe support for mobile
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStartRef.current || e.changedTouches.length === 0) return;
    const deltaX = e.changedTouches[0].clientX - touchStartRef.current.x;
    const deltaY = e.changedTouches[0].clientY - touchStartRef.current.y;
    touchStartRef.current = null;

    // Detect horizontal swipe if scale is normal (not zoomed in)
    if (Math.abs(deltaX) > 50 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5 && scale <= 1.2) {
      if (deltaX < 0) {
        goToNextPage();
      } else {
        goToPrevPage();
      }
    }
  };

  const zoomIn = () => setScale((s) => Math.min(s + 0.25, 3.0));
  const zoomOut = () => setScale((s) => Math.max(s - 0.25, 0.5));
  const resetZoom = () => setScale(1.0);
  const rotateClockwise = () => setRotation((r) => (r + 90) % 360);

  return (
    <div
      ref={containerRef}
      className={`relative flex flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] shadow-xs overflow-hidden select-none ${
        isFullscreen ? 'h-screen w-screen p-0 rounded-none z-50' : 'min-h-[500px]'
      } ${className}`}
    >
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-muted)]/40 px-3 py-2 text-sm backdrop-blur-xs">
        {/* Left: Page Navigation */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={goToPrevPage}
            disabled={currentPage <= 1 || loading}
            aria-label="Trang trước"
            title="Trang trước"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-foreground)] hover:bg-[var(--color-muted)] disabled:opacity-40 transition-colors cursor-pointer disabled:cursor-not-allowed"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>

          <span className="flex items-center gap-1 px-1 font-medium text-xs sm:text-sm text-[var(--color-foreground)]">
            <input
              type="number"
              min={1}
              max={numPages || 1}
              value={currentPage}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val >= 1 && val <= numPages) {
                  setCurrentPage(val);
                }
              }}
              className="h-7 w-12 rounded border border-[var(--color-border)] bg-[var(--color-card)] px-1 text-center font-semibold text-xs focus:ring-1 focus:ring-[var(--color-primary)] outline-none"
            />
            <span className="text-[var(--color-foreground-muted)]">/ {numPages || '...'}</span>
          </span>

          <button
            type="button"
            onClick={goToNextPage}
            disabled={currentPage >= numPages || loading}
            aria-label="Trang kế tiếp"
            title="Trang kế tiếp"
            className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-card)] text-[var(--color-foreground)] hover:bg-[var(--color-muted)] disabled:opacity-40 transition-colors cursor-pointer disabled:cursor-not-allowed"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        {/* Center / Right: Zoom & Actions */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={zoomOut}
            disabled={scale <= 0.5 || loading}
            title="Thu nhỏ"
            aria-label="Thu nhỏ"
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--color-muted)] text-[var(--color-foreground)] disabled:opacity-40 transition-colors cursor-pointer"
          >
            <ZoomOut className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={resetZoom}
            title="Đặt lại tỉ lệ (vừa màn hình)"
            className="hidden sm:inline-flex h-8 items-center px-2 text-xs font-semibold rounded-md hover:bg-[var(--color-muted)] text-[var(--color-foreground-muted)] transition-colors cursor-pointer"
          >
            {Math.round(scale * 100)}%
          </button>

          <button
            type="button"
            onClick={zoomIn}
            disabled={scale >= 3.0 || loading}
            title="Phóng to"
            aria-label="Phóng to"
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--color-muted)] text-[var(--color-foreground)] disabled:opacity-40 transition-colors cursor-pointer"
          >
            <ZoomIn className="h-4 w-4" />
          </button>

          <div className="h-4 w-[1px] bg-[var(--color-border)] mx-1" />

          <button
            type="button"
            onClick={rotateClockwise}
            title="Xoay trang"
            aria-label="Xoay trang"
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--color-muted)] text-[var(--color-foreground)] transition-colors cursor-pointer"
          >
            <RotateCw className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Thoát toàn màn hình' : 'Toàn màn hình'}
            aria-label={isFullscreen ? 'Thoát toàn màn hình' : 'Toàn màn hình'}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--color-muted)] text-[var(--color-foreground)] transition-colors cursor-pointer"
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>

          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            title="Mở trong tab mới"
            aria-label="Mở trong tab mới"
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--color-muted)] text-[var(--color-foreground)] transition-colors cursor-pointer"
          >
            <ExternalLink className="h-4 w-4" />
          </a>

          {onDownload ? (
            <button
              type="button"
              onClick={onDownload}
              disabled={isDownloading}
              title="Tải tệp về máy"
              aria-label="Tải tệp về máy"
              className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--color-muted)] text-[var(--color-foreground)] disabled:opacity-40 transition-colors cursor-pointer"
            >
              <Download className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Main Preview Area */}
      <div
        className="relative flex-1 overflow-auto bg-neutral-900/5 dark:bg-black/30 p-2 sm:p-4 flex items-center justify-center min-h-[460px] touch-pan-y"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {loading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[var(--color-card)]/80 backdrop-blur-xs">
            <Loader2 className="h-8 w-8 animate-spin text-[var(--color-primary)]" />
            <p className="text-sm font-medium text-[var(--color-foreground-muted)]">
              Đang tải tài liệu PDF...
            </p>
          </div>
        )}

        {errorMessage && (
          <div className="flex max-w-md flex-col items-center justify-center p-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10 text-red-600 mb-3">
              <AlertCircle className="h-6 w-6" />
            </div>
            <h4 className="text-base font-semibold text-[var(--color-foreground)]">
              Không thể hiển thị PDF trực tiếp
            </h4>
            <p className="mt-1 text-sm text-[var(--color-foreground-muted)]">{errorMessage}</p>
            <div className="mt-4 flex flex-wrap gap-2 justify-center">
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs hover:opacity-90 transition-opacity"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Mở trong tab mới
              </a>
              {onDownload ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-xs"
                  onClick={onDownload}
                  isLoading={isDownloading}
                >
                  <Download className="h-3.5 w-3.5" />
                  Tải về máy
                </Button>
              ) : null}
            </div>
          </div>
        )}

        {!errorMessage && (
          <div className="relative flex items-center justify-center shadow-lg transition-all">
            <canvas ref={canvasRef} className="block rounded bg-white max-w-full" />
            {pageRendering && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/10 backdrop-blur-[1px] rounded transition-opacity">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--color-primary)]" />
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom status bar */}
      <div className="flex items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-muted)]/20 px-3 sm:px-4 py-1.5 text-xs text-[var(--color-foreground-muted)]">
        <div className="flex items-center gap-1.5 truncate max-w-[200px] sm:max-w-md">
          <FileText className="h-3.5 w-3.5 shrink-0 text-red-500" />
          <span className="truncate">{fileName || 'Tài liệu PDF'}</span>
        </div>
        <div className="shrink-0 font-medium text-[var(--color-foreground)]">
          Trang {currentPage} / {numPages || 1}
        </div>
      </div>
    </div>
  );
}
