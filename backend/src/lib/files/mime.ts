import { PassThrough, type Transform } from 'node:stream';

import { fileTypeFromBuffer } from 'file-type';

/**
 * File type validation.
 *
 * The governing rule: a filename and a `Content-Type` header are both
 * attacker-controlled strings. Neither is evidence of anything. The only
 * trustworthy signal is the file's own leading bytes, so every upload is
 * sniffed and the *detected* type is what gates acceptance and drives storage.
 *
 * This matters concretely. A file named `bai-giang.pdf` with
 * `Content-Type: application/pdf` may be an HTML document, an SVG, or a ZIP
 * bomb. If we stored and later served it under the declared type, a victim's
 * browser could be persuaded to execute it in the site's own origin.
 */

/** Coarse grouping that decides which previewer runs. */
export type FileKind =
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'archive'
  | 'image'
  | 'text'
  | 'code'
  | 'other';

export interface AllowedType {
  /** MIME as reported by magic-byte detection. */
  mime: string;
  kind: FileKind;
  /** Canonical extension. Storage keys use this, never the client's. */
  extension: string;
}

/**
 * The upload allowlist.
 *
 * Deliberately absent, and not by oversight:
 *
 *   text/html        served in-origin it is stored XSS, and an uploaded HTML
 *                    file is a phishing page hosted on the university's domain
 *   image/svg+xml    XML that can carry <script>; there is no safe way to serve
 *                    it inline without sanitising, which is a separate project
 *   application/javascript, application/x-msdownload, .exe/.bat/.sh
 *
 * Adding any of these requires solving the serving problem first, not just
 * widening this list.
 */
const ALLOWED: AllowedType[] = [
  // --- Documents ------------------------------------------------------------
  { mime: 'application/pdf', kind: 'pdf', extension: 'pdf' },
  { mime: 'application/msword', kind: 'document', extension: 'doc' },
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kind: 'document',
    extension: 'docx',
  },
  { mime: 'application/vnd.oasis.opendocument.text', kind: 'document', extension: 'odt' },
  { mime: 'application/rtf', kind: 'document', extension: 'rtf' },

  // --- Spreadsheets ---------------------------------------------------------
  { mime: 'application/vnd.ms-excel', kind: 'spreadsheet', extension: 'xls' },
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    kind: 'spreadsheet',
    extension: 'xlsx',
  },
  { mime: 'application/vnd.oasis.opendocument.spreadsheet', kind: 'spreadsheet', extension: 'ods' },
  { mime: 'text/csv', kind: 'spreadsheet', extension: 'csv' },

  // --- Presentations --------------------------------------------------------
  { mime: 'application/vnd.ms-powerpoint', kind: 'presentation', extension: 'ppt' },
  {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    kind: 'presentation',
    extension: 'pptx',
  },
  { mime: 'application/vnd.oasis.opendocument.presentation', kind: 'presentation', extension: 'odp' },

  // --- Archives -------------------------------------------------------------
  { mime: 'application/zip', kind: 'archive', extension: 'zip' },
  { mime: 'application/x-rar-compressed', kind: 'archive', extension: 'rar' },
  { mime: 'application/x-7z-compressed', kind: 'archive', extension: '7z' },
  { mime: 'application/x-tar', kind: 'archive', extension: 'tar' },
  { mime: 'application/gzip', kind: 'archive', extension: 'gz' },

  // --- Images ---------------------------------------------------------------
  { mime: 'image/png', kind: 'image', extension: 'png' },
  { mime: 'image/jpeg', kind: 'image', extension: 'jpg' },
  { mime: 'image/gif', kind: 'image', extension: 'gif' },
  { mime: 'image/webp', kind: 'image', extension: 'webp' },
  { mime: 'image/bmp', kind: 'image', extension: 'bmp' },
  { mime: 'image/tiff', kind: 'image', extension: 'tiff' },

  // --- Plain text and data --------------------------------------------------
  { mime: 'text/plain', kind: 'text', extension: 'txt' },
  { mime: 'text/markdown', kind: 'text', extension: 'md' },
];

const BY_MIME = new Map(ALLOWED.map((entry) => [entry.mime, entry]));

/**
 * Extensions that map to a source-code kind.
 *
 * `file-type` cannot detect these — they are plain text with no signature — so
 * they are recognised by extension and then REQUIRED to sniff as text. That
 * ordering matters: extension alone must never be sufficient, or `.js` would
 * become a way to store arbitrary content.
 */
const CODE_EXTENSIONS = new Set([
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'cs', 'java', 'kt', 'py', 'rb', 'go', 'rs',
  'php', 'js', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'swift', 'm', 'scala', 'lua',
  'pl', 'r', 'jl', 'dart', 'sql', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'dockerfile',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'xml', 'json', 'yaml', 'yml',
  'toml', 'ini', 'cfg', 'conf', 'env', 'gradle', 'makefile', 'cmake',
]);

/** Text formats whose MIME detection is unreliable. */
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'csv', 'log', 'rtf']);

export const ALLOWED_MIME_TYPES = ALLOWED.map((a) => a.mime);

/** Human-readable list for the upload error message. */
export const ALLOWED_EXTENSIONS = [
  ...new Set([...ALLOWED.map((a) => a.extension), ...CODE_EXTENSIONS, ...TEXT_EXTENSIONS]),
].sort();

export interface DetectionResult {
  /** MIME confirmed from the bytes, or inferred for text formats. */
  mime: string;
  kind: FileKind;
  extension: string;
  /** False when the declared type disagreed with the detected one. */
  declaredMatches: boolean;
}

export class UnsupportedFileTypeError extends Error {
  readonly code = 'FILE_TYPE_NOT_ALLOWED';
  constructor(
    readonly detected: string | null,
    readonly declared: string | null,
    readonly originalName: string,
  ) {
    super(
      `Unsupported file type for "${originalName}" ` +
        `(declared ${declared ?? 'nothing'}, detected ${detected ?? 'unknown'}).`,
    );
    this.name = 'UnsupportedFileTypeError';
  }
}

export class FileSignatureMismatchError extends Error {
  readonly code = 'FILE_SIGNATURE_MISMATCH';
  constructor(
    readonly declared: string | null,
    readonly detected: string,
    readonly originalName: string,
  ) {
    super(
      `"${originalName}" claims to be ${declared} but its contents are ${detected}.`,
    );
    this.name = 'FileSignatureMismatchError';
  }
}

const ZIP_CONTAINER_REFINEMENTS: Record<string, AllowedType> = {
  pptx: {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    kind: 'presentation',
    extension: 'pptx',
  },
  ppsx: {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    kind: 'presentation',
    extension: 'pptx',
  },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kind: 'document',
    extension: 'docx',
  },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    kind: 'spreadsheet',
    extension: 'xlsx',
  },
  odt: {
    mime: 'application/vnd.oasis.opendocument.text',
    kind: 'document',
    extension: 'odt',
  },
  ods: {
    mime: 'application/vnd.oasis.opendocument.spreadsheet',
    kind: 'spreadsheet',
    extension: 'ods',
  },
  odp: {
    mime: 'application/vnd.oasis.opendocument.presentation',
    kind: 'presentation',
    extension: 'odp',
  },
};

const CFB_CONTAINER_REFINEMENTS: Record<string, AllowedType> = {
  doc: {
    mime: 'application/msword',
    kind: 'document',
    extension: 'doc',
  },
  dot: {
    mime: 'application/msword',
    kind: 'document',
    extension: 'doc',
  },
  xls: {
    mime: 'application/vnd.ms-excel',
    kind: 'spreadsheet',
    extension: 'xls',
  },
  xlt: {
    mime: 'application/vnd.ms-excel',
    kind: 'spreadsheet',
    extension: 'xls',
  },
  ppt: {
    mime: 'application/vnd.ms-powerpoint',
    kind: 'presentation',
    extension: 'ppt',
  },
  pps: {
    mime: 'application/vnd.ms-powerpoint',
    kind: 'presentation',
    extension: 'ppt',
  },
};

/**
 * Magic-byte sniffing, plus text-format fallback.
 *
 * Returns null when nothing matches — the caller treats that as a rejection
 * rather than guessing.
 */
export async function detectFileType(
  head: Buffer,
  originalName: string,
  declaredMime: string | null,
): Promise<DetectionResult | null> {
  const extension = (originalName.split('.').pop() ?? '').toLowerCase();
  const detected = await fileTypeFromBuffer(head);

  // --- Strong signature present --------------------------------------------
  if (detected) {
    let effectiveMime: string = detected.mime;
    let allowed: AllowedType | undefined = BY_MIME.get(effectiveMime);

    // Refine generic ZIP / CFB container to specific Office type if extension or declared MIME matches.
    // OOXML files (.pptx, .docx, .xlsx) are ZIP archives. When sniffing only the leading 4KB (SNIFF_BYTES),
    // file-type frequently reports generic 'application/zip' if internal directories appear later.
    if (detected.mime === 'application/zip') {
      const refined = ZIP_CONTAINER_REFINEMENTS[extension];
      if (refined) {
        allowed = refined;
        effectiveMime = refined.mime;
      } else if (declaredMime && isCompatible(declaredMime, 'application/zip')) {
        const declaredAllowed = BY_MIME.get(declaredMime);
        if (declaredAllowed && declaredAllowed.mime !== 'application/zip') {
          allowed = declaredAllowed;
          effectiveMime = declaredAllowed.mime;
        }
      }
    } else if (detected.mime === 'application/x-cfb') {
      const refined = CFB_CONTAINER_REFINEMENTS[extension];
      if (refined) {
        allowed = refined;
        effectiveMime = refined.mime;
      } else if (declaredMime && isCompatible(declaredMime, 'application/x-cfb')) {
        const declaredAllowed = BY_MIME.get(declaredMime);
        if (declaredAllowed) {
          allowed = declaredAllowed;
          effectiveMime = declaredAllowed.mime;
        }
      }
    }

    if (!allowed) {
      // Detected something real, but it is not on the allowlist. Do not fall
      // through to the text path: a ZIP-based .docx carries the archive
      // signature, and treating it as text would let any binary through by
      // naming it .txt.
      throw new UnsupportedFileTypeError(detected.mime, declaredMime, originalName);
    }

    // A declared type that contradicts the bytes is a red flag, not a
    // formality — it is the exact shape of a file-type spoofing attempt.
    if (declaredMime && declaredMime !== effectiveMime && !isCompatible(declaredMime, effectiveMime)) {
      throw new FileSignatureMismatchError(declaredMime, effectiveMime, originalName);
    }

    return {
      mime: effectiveMime,
      kind: allowed.kind,
      extension: allowed.extension,
      declaredMatches: true,
    };
  }

  // --- No signature: text formats ------------------------------------------
  if (!looksLikeText(head)) {
    throw new UnsupportedFileTypeError(null, declaredMime, originalName);
  }

  if (CODE_EXTENSIONS.has(extension)) {
    if (declaredMime && !isTextualMime(declaredMime)) {
      throw new FileSignatureMismatchError(declaredMime, 'text/plain', originalName);
    }
    return { mime: 'text/plain', kind: 'code', extension, declaredMatches: true };
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    if (declaredMime && !isTextualMime(declaredMime)) {
      throw new FileSignatureMismatchError(declaredMime, 'text/plain', originalName);
    }
    const mapping = BY_MIME.get('text/plain')!;
    return { mime: 'text/plain', kind: mapping.kind, extension, declaredMatches: true };
  }

  // Readable as text but with an unrecognised extension: accept as plain text
  // rather than rejecting a student's notes.txt-alike for a cosmetic reason.
  if (declaredMime && isTextualMime(declaredMime)) {
    return { mime: 'text/plain', kind: 'text', extension: extension || 'txt', declaredMatches: true };
  }

  throw new UnsupportedFileTypeError(null, declaredMime, originalName);
}

/**
 * Some containers are legitimately reported several ways.
 *
 * A .docx is a ZIP, and depending on the leading bytes `file-type` may report
 * either the specific OOXML type or a bare `application/zip`. Both are correct
 * descriptions of the same bytes, so treating that pair as a mismatch would
 * reject every Word document.
 */
function isCompatible(declared: string, detected: string): boolean {
  if (declared === 'application/octet-stream') return true;

  const zipBased = new Set([
    'application/zip',
    'application/x-zip-compressed',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
  ]);
  if (zipBased.has(declared) && zipBased.has(detected)) return true;

  // Legacy Office formats share the OLE2 container.
  const oleBased = new Set([
    'application/x-cfb',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
  ]);
  if (oleBased.has(declared) && oleBased.has(detected)) return true;

  // Markdown is plain text to a sniffer.
  if (declared === 'text/markdown' && detected === 'text/plain') return true;
  if (declared === 'text/csv' && detected === 'text/plain') return true;

  return false;
}

function isTextualMime(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml';
}

/**
 * Heuristic check for "this is text, not a binary".
 *
 * A NUL byte in the first few KB is the standard signal: no text encoding in
 * use produces one, while virtually every binary format does. Also requires
 * that most bytes are printable, so a file of random bytes without a NUL is
 * still rejected.
 */
export function looksLikeText(head: Buffer): boolean {
  if (head.length === 0) return false;

  const sample = head.subarray(0, Math.min(head.length, 4096));

  if (sample.includes(0)) return false;

  let printable = 0;
  for (const byte of sample) {
    // Tab, LF, CR, and the printable ASCII range; plus any high byte, which
    // covers UTF-8 multibyte sequences carrying Vietnamese diacritics.
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126) || byte >= 128) {
      printable += 1;
    }
  }

  return printable / sample.length > 0.95;
}

/**
 * How many leading bytes to capture for detection.
 *
 * Enough for every signature `file-type` recognises, and small enough that
 * buffering it does not undermine streaming an 8MB chunk.
 */
export const SNIFF_BYTES = 4100;

/**
 * Transform that captures the first N bytes while passing everything through,
 * and exposes a promise that resolves once enough has been seen.
 *
 * The promise resolves from INSIDE the transform, never from an external
 * `'data'` listener. That distinction is not cosmetic: attaching a `'data'`
 * listener to a PassThrough switches it into flowing mode and drains it into
 * the listener, so the bytes are gone by the time the stream is piped to
 * storage. The upload then arrives as zero bytes and fails a size check with a
 * confusing message. Resolving internally leaves the stream untouched and
 * correctly backpressured.
 *
 * This is what allows sniffing without buffering: only the first few KB are
 * copied aside for inspection while the full stream continues to storage.
 */
export function createHeadCapture(limit = SNIFF_BYTES): {
  stream: Transform;
  head: Promise<Buffer>;
} {
  const chunks: Buffer[] = [];
  let captured = 0;
  let settled = false;

  let resolveHead!: (value: Buffer) => void;
  const head = new Promise<Buffer>((resolve) => {
    resolveHead = resolve;
  });

  const settle = () => {
    if (settled) return;
    settled = true;
    resolveHead(Buffer.concat(chunks));
  };

  const stream = new PassThrough({
    transform(chunk: Buffer, _encoding, callback) {
      if (captured < limit) {
        const take = Math.min(limit - captured, chunk.length);
        // Copy: the source buffer may be recycled once the callback returns.
        chunks.push(Buffer.from(chunk.subarray(0, take)));
        captured += take;
        if (captured >= limit) settle();
      }
      callback(null, chunk);
    },
    flush(callback) {
      // A file smaller than the sniff window ends here. Resolving on 'end'
      // instead would race the pipe teardown.
      settle();
      callback();
    },
  });

  return { stream, head };
}

/**
 * Storage key. Randomised, never derived from the user's filename.
 *
 * Deliberately carries NO file extension. At the moment a chunked upload
 * begins we do not yet know the real type — that is only established when the
 * first chunk's magic bytes arrive — so any extension here would be a guess.
 * A wrong extension is worse than none: it misleads anyone browsing the bucket
 * and invites a future reader to trust it. The authoritative type lives in
 * `storage_objects.detected_mime` and drives the `Content-Type` on download.
 *
 * The uuid is time-ordered, which keeps keys roughly sorted by upload date —
 * useful for listing and storage-side range scans — while staying unguessable.
 */
export function buildStorageKey(now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `documents/${year}/${month}/${crypto.randomUUID()}`;
}

/** Key for a derived artifact (an Office preview PDF), which does know its type. */
export function buildDerivedKey(sourceKey: string, suffix: string, extension: string): string {
  const safeSuffix = suffix.replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'derived';
  const safeExtension = extension.replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'bin';
  return `${sourceKey}.${safeSuffix}.${safeExtension}`;
}
