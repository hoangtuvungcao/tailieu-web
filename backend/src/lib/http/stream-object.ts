import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../errors.js';
import { contentDisposition } from './content-disposition.js';
import { getStorage } from '../storage/index.js';
import type { ObjectLocation } from '../storage/storage.interface.js';

/**
 * Serve a stored object through the API, range requests included.
 *
 * WHY THIS EXISTS AT ALL, given the storage layer can mint a signed URL.
 *
 * A signed URL points at the storage origin. From the site's point of view
 * that is a third party, so the browser puts it in a partitioned context and
 * logs "Partitioned cookie or storage access was provided to ... because it is
 * loaded in the third-party context" on every preview and every download. It
 * is only a warning, but it is a warning on the product's most-used feature,
 * it breaks the `<a download>` attribute (browsers ignore it cross-origin, so
 * the file saves under the storage key instead of its real name), and it means
 * the storage endpoint has to be publicly reachable at all.
 *
 * Proxying costs bandwidth through the tunnel. That is a real price and it is
 * paid deliberately: correctness of the download filename and one origin for
 * the whole site are worth more than offloading the bytes, and self-hosting
 * the storage origin behind the tunnel would pay the same bandwidth anyway.
 *
 * RANGE REQUESTS are the reason this is not four lines. A PDF viewer reads the
 * trailer at the end of the file, then seeks — without `Accept-Ranges` it
 * downloads the entire document before showing page one. The header handling
 * below is what makes an in-browser preview usable at all.
 */

export interface StreamObjectOptions {
  location: ObjectLocation;
  contentType: string;
  /**
   * `inline` shows the object in the page; `attachment` saves it. The filename
   * is what the save dialog offers — omitting it makes the browser fall back
   * to the URL, which for a storage key is a UUID with no extension.
   */
  disposition?: { kind: 'inline' | 'attachment'; filename: string };
  /**
   * `private` keeps a shared cache from serving one user's document to
   * another. Anything authorized must be private; only public assets may be
   * `public`.
   */
  cacheControl?: string;
  /**
   * Reject ranges beyond this, so a crafted `Range: bytes=0-` on a huge object
   * cannot be used to pull it over and over. Left undefined means no cap.
   */
  maxRangeBytes?: number;
}

interface ParsedRange {
  start: number;
  end: number;
}

/**
 * Parse an HTTP `Range` header against a known total size.
 *
 * Returns `null` for no header, the parsed range when satisfiable, and throws
 * 416 when it is not — a viewer that receives 200 instead of 416 when asking
 * for bytes past the end will loop.
 *
 * Only the single-range form is supported. Multipart ranges
 * (`bytes=0-99,200-299`) need a multipart/byteranges response body, and no
 * browser PDF viewer or media element sends one.
 */
function parseRange(header: string | undefined, total: number): ParsedRange | null {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start: number;
  let end: number;

  if (rawStart === '') {
    // A suffix range: the last N bytes. `bytes=-500` on a 100-byte object
    // means the whole object, not an error.
    const suffixLength = Number(rawEnd);
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    throw new AppError('MEDIA_RANGE_INVALID', 'Dải byte yêu cầu không hợp lệ.');
  }

  return { start, end };
}

export async function streamObject(
  request: FastifyRequest,
  reply: FastifyReply,
  options: StreamObjectOptions,
): Promise<FastifyReply> {
  const storage = getStorage();

  const total = await storage.objectSize(options.location);
  if (total === null) {
    throw new AppError('MEDIA_NOT_FOUND', 'Không tìm thấy tệp.');
  }

  const rangeHeader = request.headers.range;
  let range: ParsedRange | null = null;

  try {
    range = parseRange(rangeHeader, total);
  } catch (error) {
    // 416 must carry `Content-Range: bytes */<total>` so the client learns the
    // real size and can retry — without it the viewer has no way back.
    reply.header('content-range', `bytes */${total}`);
    throw error;
  }

  if (range && options.maxRangeBytes && range.end - range.start + 1 > options.maxRangeBytes) {
    range.end = range.start + options.maxRangeBytes - 1;
  }

  const stream = await storage.getStream(
    options.location,
    range ? { range: { start: range.start, end: range.end } } : undefined,
  );

  reply
    .header('content-type', options.contentType)
    .header('accept-ranges', 'bytes')
    .header('cache-control', options.cacheControl ?? 'private, no-store')
    // The content type above is what the *upload* claimed, verified against the
    // detected kind. `nosniff` stops a browser from second-guessing it and
    // rendering an upload as HTML, which would be stored XSS on this origin.
    .header('x-content-type-options', 'nosniff');

  if (options.disposition) {
    reply.header(
      'content-disposition',
      contentDisposition(options.disposition.filename, options.disposition.kind),
    );
  }

  if (range) {
    const length = range.end - range.start + 1;
    reply
      .status(206)
      .header('content-range', `bytes ${range.start}-${range.end}/${total}`)
      .header('content-length', String(length));
  } else {
    reply.header('content-length', String(total));
  }

  return reply.send(stream);
}
