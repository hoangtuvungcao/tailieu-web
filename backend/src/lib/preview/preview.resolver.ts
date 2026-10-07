/**
 * Preview resolution.
 *
 * §9 asks for a preview abstraction that is "clear", and the reason that
 * matters is that preview is the part of a document platform most likely to
 * quietly become a conversion pipeline. This file decides *what* can be shown
 * and *how*; it never performs the conversion. The worker does that.
 *
 * The four kinds, and who is responsible for each:
 *
 *   pdf      the object already IS a PDF — serve it inline, signed URL
 *   image    the browser renders it — serve it inline, signed URL
 *   text     fetched as text and syntax-highlighted client-side
 *   office   needs conversion — a PDF artifact is produced by the worker
 *   none     no preview; offer the download instead
 *
 * Being explicit about `none` is deliberate. A resolver that throws, or that
 * returns a URL that 404s, produces an error the user cannot act on. Returning
 * "this format has no preview, here is the download" is a better product and
 * an honest one.
 */

export type PreviewKind = 'pdf' | 'image' | 'text' | 'office' | 'none';

export interface PreviewSource {
  fileId: string;
  detectedMime: string;
  fileKind: string;
  originalName: string;
  /** Whether a converted PDF artifact exists yet. */
  previewStatus: 'none' | 'queued' | 'processing' | 'ready' | 'failed' | 'unsupported';
}

export interface PreviewDescriptor {
  kind: PreviewKind;
  /** True when the browser can render it directly from a signed URL. */
  inline: boolean;
  fileId: string;
  mimeType: string;
  /**
   * For office documents: where the conversion stands. The UI shows different
   * copy for each — "converting, try again shortly" is a very different
   * message from "this format cannot be previewed".
   */
  conversion:
    | 'not_needed'
    | 'pending'
    | 'ready'
    | 'failed'
    | 'unsupported';
}

/** MIME types the browser renders natively from a signed URL. */
const INLINE_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'text/plain',
]);

/**
 * Office formats that LibreOffice can convert.
 *
 * Anything not listed is reported as `unsupported` rather than queued. A job
 * that is guaranteed to fail wastes a worker slot and produces a `failed`
 * status the user cannot act on — better to say so immediately.
 */
const CONVERTIBLE_MIME = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'application/rtf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/csv',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
  'application/x-cfb',
  'application/x-ole-storage',
]);

const CONVERTIBLE_EXTENSIONS = new Set([
  'doc', 'docx', 'dot', 'odt', 'rtf',
  'xls', 'xlsx', 'xlt', 'ods', 'csv',
  'ppt', 'pptx', 'pps', 'odp',
]);

export function isConvertibleMime(mime: string): boolean {
  return CONVERTIBLE_MIME.has(mime) || mime === 'application/x-cfb' || mime === 'application/x-ole-storage';
}

export function isConvertibleFile(mime: string, originalName?: string): boolean {
  if (isConvertibleMime(mime)) return true;
  if (originalName) {
    const ext = (originalName.split('.').pop() ?? '').toLowerCase();
    if (CONVERTIBLE_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

export function needsConversion(mime: string, originalName?: string): boolean {
  return isConvertibleFile(mime, originalName);
}

export function isConvertible(mime: string, originalName?: string): boolean {
  return isConvertibleFile(mime, originalName);
}

/**
 * Decide how a file should be previewed.
 *
 * Pure and synchronous so it can be called from the API on every read without
 * touching the database or storage.
 */
export function resolvePreview(source: PreviewSource): PreviewDescriptor {
  const { detectedMime, previewStatus, fileId, originalName } = source;

  // --- Office: depends on the conversion artifact --------------------------
  if (needsConversion(detectedMime, originalName)) {
    return {
      kind: 'office',
      // An office document becomes inline-renderable only once its PDF exists.
      inline: previewStatus === 'ready',
      fileId,
      mimeType: detectedMime,
      conversion: mapConversionStatus(previewStatus),
    };
  }

  // --- Code and other plain text -------------------------------------------
  // Handled before the inline check because `text/plain` is inline-renderable
  // but wants different treatment: it is fetched and highlighted rather than
  // displayed raw, so `kind` distinguishes the two paths.
  if (source.fileKind === 'code') {
    return { kind: 'text', inline: true, fileId, mimeType: detectedMime, conversion: 'not_needed' };
  }

  // --- Natively renderable -------------------------------------------------
  if (INLINE_MIME.has(detectedMime)) {
    const isPdf = detectedMime === 'application/pdf';
    return {
      kind: isPdf ? 'pdf' : detectedMime.startsWith('image/') ? 'image' : 'text',
      inline: true,
      fileId,
      mimeType: detectedMime,
      conversion: 'not_needed',
    };
  }

  // --- Everything else -----------------------------------------------------
  // Archives, unknown binaries, formats LibreOffice cannot open. Explicitly
  // `none` rather than a URL that would fail.
  return { kind: 'none', inline: false, fileId, mimeType: detectedMime, conversion: 'not_needed' };
}

function mapConversionStatus(
  status: PreviewSource['previewStatus'],
): PreviewDescriptor['conversion'] {
  switch (status) {
    case 'ready':
      return 'ready';
    case 'queued':
    case 'processing':
      return 'pending';
    case 'failed':
      return 'failed';
    case 'unsupported':
      return 'unsupported';
    case 'none':
    default:
      // The row exists but was never queued — treat as pending so the API can
      // enqueue it lazily rather than requiring a backfill migration.
      return 'pending';
  }
}

/**
 * Whether the download response should be `inline` or `attachment`.
 *
 * Only formats the resolver considers inline-safe get `inline`. Everything else
 * is forced to `attachment` so a crafted file cannot be interpreted as active
 * content in the site's own origin — which is why `text/html` and
 * `image/svg+xml` are absent from the allowlist entirely.
 */
export function dispositionFor(mime: string): 'inline' | 'attachment' {
  return INLINE_MIME.has(mime) ? 'inline' : 'attachment';
}
