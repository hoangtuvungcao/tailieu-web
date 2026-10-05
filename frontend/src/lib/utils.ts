import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge Tailwind class names.
 *
 * `clsx` handles conditionals; `twMerge` resolves conflicts so a caller can
 * override a component's default padding without the two classes fighting —
 * without it, `cn('p-4', 'p-2')` emits both and CSS source order decides, which
 * is never what the caller meant.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Format a byte count for display.
 *
 * Binary units with a space, because the audience is students comparing file
 * sizes against a download limit — "1.5 GB" is what the limit is expressed in.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

/**
 * Relative time in Vietnamese.
 *
 * `Intl.RelativeTimeFormat` rather than a date library: it is built in, weighs
 * nothing, and already knows Vietnamese phrasing. Pulling in moment or
 * date-fns for this one function would add tens of kilobytes to the bundle.
 */
const relativeFormatter = new Intl.RelativeTimeFormat('vi', { numeric: 'auto' });
const absoluteFormatter = new Intl.DateTimeFormat('vi', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

export function formatRelativeTime(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const thresholds: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'second'],
    [3600, 'minute'],
    [86_400, 'hour'],
    [604_800, 'day'],
    [2_592_000, 'week'],
    [31_536_000, 'month'],
  ];

  for (const [limit, unit] of thresholds) {
    if (Math.abs(diffSeconds) < limit) {
      const divisor = unit === 'second' ? 1 : unit === 'minute' ? 60 : unit === 'hour' ? 3600 : unit === 'day' ? 86_400 : unit === 'week' ? 604_800 : 2_592_000;
      return relativeFormatter.format(Math.round(diffSeconds / divisor), unit);
    }
  }

  return absoluteFormatter.format(date);
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : absoluteFormatter.format(date);
}

/** Vietnamese display names for the file kinds the API returns. */
export const FILE_KIND_LABELS: Record<string, string> = {
  pdf: 'PDF',
  document: 'Văn bản',
  spreadsheet: 'Bảng tính',
  presentation: 'Slide',
  archive: 'Nén',
  image: 'Hình ảnh',
  text: 'Văn bản',
  code: 'Mã nguồn',
  other: 'Khác',
};

export const DOCUMENT_STATUS_LABELS: Record<string, string> = {
  draft: 'Bản nháp',
  pending_review: 'Chờ kiểm duyệt',
  published: 'Đã đăng',
  rejected: 'Bị từ chối',
  archived: 'Đã lưu trữ',
};

export const VISIBILITY_LABELS: Record<string, string> = {
  public: 'Công khai',
  internal: 'Nội bộ',
  private: 'Riêng tư',
};

/**
 * Split highlighted search text into segments.
 *
 * The API wraps matched terms in U+0002 / U+0003. The caller MUST render each
 * segment as a text node — never with `dangerouslySetInnerHTML`. A document
 * titled `<script>alert(1)</script>` is legal input, and injecting it as HTML
 * on the search results page would be stored XSS.
 */
export const HIGHLIGHT_START = '\u0002';
export const HIGHLIGHT_END = '\u0003';

/**
 * Split highlighted search text into segments.
 *
 * The API wraps matched terms in U+0002 / U+0003 — C0 control characters that
 * cannot legitimately appear in a title. Splitting on them is therefore
 * unambiguous and needs no escaping.
 *
 * The caller MUST render each segment as a text node, never with
 * `dangerouslySetInnerHTML`. Angle brackets carry no meaning here: a document
 * titled `<script>alert(1)</script>` is legal input, and joining these segments
 * into HTML would make it stored XSS on the search results page.
 *
 * This function previously lived only in `DocumentCard.tsx` as a local
 * duplicate, which is why deleting it from here broke nothing visible — and
 * why it went unnoticed. The duplicate is now removed.
 */
export function parseHighlight(value: string): { text: string; matched: boolean }[] {
  const segments: { text: string; matched: boolean }[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    const start = value.indexOf(HIGHLIGHT_START, cursor);

    if (start === -1) {
      segments.push({ text: value.slice(cursor), matched: false });
      break;
    }

    if (start > cursor) {
      segments.push({ text: value.slice(cursor, start), matched: false });
    }

    const end = value.indexOf(HIGHLIGHT_END, start + 1);
    if (end === -1) {
      // Unbalanced marker from a malformed response: treat the remainder as
      // plain text rather than dropping it.
      segments.push({ text: value.slice(start + 1), matched: false });
      break;
    }

    segments.push({ text: value.slice(start + 1, end), matched: true });
    cursor = end + 1;
  }

  return segments.length > 0 ? segments : [{ text: value, matched: false }];
}
