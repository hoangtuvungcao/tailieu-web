/**
 * Content-Disposition header construction (RFC 6266 + RFC 5987).
 *
 * This is not a one-liner because of Vietnamese filenames. A header like
 *
 *   Content-Disposition: attachment; filename="Bài giảng C++.pdf"
 *
 * is invalid — HTTP headers are ISO-8859-1, so the raw UTF-8 bytes of "à" and
 * "ả" arrive mangled and the user downloads a file named "BÃ i giáº£ng". The
 * fix is to send both forms: a sanitised ASCII `filename` for old clients and
 * an RFC 5987 `filename*=UTF-8''...` with percent-encoding for everything
 * modern. Getting this wrong is the difference between a download that works
 * and one that produces a file nobody can open by double-clicking.
 */

/** Characters that are unsafe or ambiguous inside a quoted-string header. */
const UNSAFE_ASCII = /[^\x20-\x7E]/g;

function asciiFallback(filename: string): string {
  const stripped = filename
    // Fold common Vietnamese diacritics so the ASCII fallback stays readable
    // rather than turning into a row of question marks.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(UNSAFE_ASCII, '_')
    .replace(/["\\]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  // A filename that folds away entirely must still produce a usable name.
  return stripped.length > 0 ? stripped.slice(0, 200) : 'download';
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build a Content-Disposition value.
 *
 * `inline` lets PDFs and images render in the browser; anything else should be
 * `attachment`, so a crafted file can never be interpreted as active content
 * in the site's own origin.
 */
export function contentDisposition(filename: string, disposition: 'inline' | 'attachment' = 'attachment'): string {
  const fallback = asciiFallback(filename);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

/**
 * Strip any path component from a client-supplied filename.
 *
 * A browser sends only the basename, but nothing stops a crafted client from
 * sending `../../etc/passwd` or `..\\..\\windows\\system32\\config`. The name
 * is never used to build a storage key, but it is echoed back in a download
 * header and shown in the UI, so it must not be able to traverse anywhere.
 */
export function sanitizeFilename(input: string): string {
  const basename = input.split(/[/\\]/).pop() ?? '';
  const cleaned = basename
    // Control characters can be used to smuggle header content.
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 255) : 'unnamed';
}
