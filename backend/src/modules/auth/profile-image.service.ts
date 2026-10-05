import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { detectFileType, UnsupportedFileTypeError, FileSignatureMismatchError } from '../../lib/files/mime.js';
import { getStorage } from '../../lib/storage/index.js';
import { mediaKeyFromPath, mediaPublicPath, type PublicMediaKind } from '../media/media.paths.js';
import * as repo from './auth.repository.js';

/**
 * Profile images — the avatar and the cover.
 *
 * WHAT GOES IN THE COLUMN. `users.avatar_url` holds a public API path such as
 * `/api/v1/media/avatars/<uuid>/<uuid>.png`, not a storage key and not an
 * absolute URL. Three consequences, all deliberate:
 *
 *   Every surface that already renders `avatar_url` works unchanged. The
 *   documents list, the community feed, the follower list and the notification
 *   payload all pass the column straight into an `<img src>`; if this column
 *   held a bare object key they would all need a mapping step, and the one
 *   that was forgotten would render a broken image.
 *
 *   It is served from the site's own origin, so an avatar is not a third-party
 *   request and the browser does not partition storage for it.
 *
 *   Absolute URLs would break local development, where the API is on :4000 and
 *   the site on :5173. A relative path is resolved by whatever origin is
 *   serving the page, which is what the Pages proxy and the Vite proxy both
 *   exist to make true.
 *
 * The path embeds the storage key because the key already contains a UUID, so
 * it is unguessable, and avatars are public by definition. Documents are not
 * served this way — their content route takes a signed token and never reveals
 * a key.
 *
 * WHY UPLOAD AND NOT A URL FIELD. Letting a user paste an avatar URL would make
 * the site fetch an arbitrary third-party address on behalf of every visitor,
 * which is a tracking pixel and an SSRF surface in one.
 */

export type ProfileImageKind = 'avatar' | 'cover';

/** Directory prefix in the bucket, per kind. Also the URL segment. */
const PREFIX: Record<ProfileImageKind, PublicMediaKind> = {
  avatar: 'avatars',
  cover: 'covers',
};

/**
 * 2 MB for an avatar, 5 MB for a cover.
 *
 * Generous for a photograph and small enough that the whole image can be held
 * in memory for signature detection, which is the point: these are read into a
 * buffer rather than streamed, because the bytes have to be inspected before
 * anything is written to the bucket.
 */
const MAX_BYTES: Record<ProfileImageKind, number> = {
  avatar: 2 * 1024 * 1024,
  cover: 5 * 1024 * 1024,
};

const LABEL: Record<ProfileImageKind, string> = {
  avatar: 'ảnh đại diện',
  cover: 'ảnh bìa',
};

/** "Ảnh đại diện" — for the start of a sentence. `charAt` avoids the indexed
 *  access that would widen to `string | undefined` under strict settings. */
function subject(kind: ProfileImageKind): string {
  const label = LABEL[kind];
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Maps a detected MIME to the extension used in the key. */
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Public path for an object this module wrote. */
export function publicPath(kind: ProfileImageKind, key: string): string {
  return mediaPublicPath(key);
}

/**
 * Recover the storage key from a value this module previously wrote.
 *
 * Returns null for anything that is not one of our own paths — an externally
 * hosted URL, a value written before this existed, or a tampered one. The
 * caller treats null as "nothing of ours to delete", which is the correct and
 * safe reading: leaving an orphaned object costs a few kilobytes, whereas
 * deleting the wrong key would destroy somebody's document.
 */
export function keyFromPublicPath(kind: ProfileImageKind, url: string | null): string | null {
  const key = url ? mediaKeyFromPath(url) : null;
  if (!key) return null;

  // The kind is part of the key, so a cover can never be used to delete an
  // avatar, or the reverse.
  return key.startsWith(`${PREFIX[kind]}/`) ? key : null;
}

export interface StoredImage {
  /** The public API path, ready to store in the column and render. */
  url: string;
  /** The key that was written, for logging. */
  key: string;
}

/**
 * Validate and store one uploaded image.
 *
 * The declared MIME is passed through to detection rather than trusted: a
 * client can claim `image/png` for anything, and `detectFileType` rejects a
 * file whose bytes contradict its declared type. An image is the one upload
 * class rendered by the browser on this origin, so the check is not a
 * formality — an SVG or an HTML file accepted here would be stored XSS.
 */
export async function store(
  userId: string,
  kind: ProfileImageKind,
  buffer: Buffer,
  originalName: string,
  declaredMime: string | null,
): Promise<StoredImage> {
  if (buffer.length === 0) {
    throw new AppError('FILE_TYPE_NOT_ALLOWED', `Tệp ${LABEL[kind]} rỗng.`);
  }

  if (buffer.length > MAX_BYTES[kind]) {
    const limitMb = Math.round(MAX_BYTES[kind] / (1024 * 1024));
    throw new AppError(
      'FILE_TYPE_NOT_ALLOWED',
      `${subject(kind)} không được vượt quá ${limitMb} MB.`,
    );
  }

  let mime: string;
  try {
    const detected = await detectFileType(buffer, originalName, declaredMime);
    if (!detected || detected.kind !== 'image') {
      throw new AppError(
        'FILE_TYPE_NOT_ALLOWED',
        `${subject(kind)} phải là tệp ảnh PNG, JPEG, WebP hoặc GIF.`,
      );
    }
    mime = detected.mime;
  } catch (error) {
    // Rethrown with a message a person can act on. The low-level errors name
    // MIME types, which is useful in a log and useless in a form.
    if (error instanceof AppError) throw error;
    if (error instanceof UnsupportedFileTypeError || error instanceof FileSignatureMismatchError) {
      throw new AppError(
        'FILE_TYPE_NOT_ALLOWED',
        `${subject(kind)} phải là tệp ảnh PNG, JPEG, WebP hoặc GIF.`,
      );
    }
    throw error;
  }

  const extension = EXTENSION_BY_MIME[mime];
  if (!extension) {
    throw new AppError('FILE_TYPE_NOT_ALLOWED', 'Định dạng ảnh không được hỗ trợ.');
  }

  // A fresh UUID per upload, so the URL changes and every cache — the
  // browser's, Cloudflare's, a chat client's link preview — is invalidated
  // without a cache-busting query or a purge.
  const key = `${PREFIX[kind]}/${userId}/${randomUUID()}.${extension}`;
  await getStorage().putStream({
    bucket: env.S3_BUCKET,
    key,
    body: Readable.from([buffer]),
    contentType: mime,
    maxBytes: MAX_BYTES[kind],
    metadata: { userId, purpose: kind },
  });

  return { url: publicPath(kind, key), key };
}

/**
 * Delete a previously stored image.
 *
 * Best-effort by design: a missing object is the desired end state, so a
 * failure here must not fail the request that triggered it. The account has
 * already stopped referencing the image, and an orphan in the bucket is
 * collected by the reaper.
 */
export async function remove(url: string | null, kind: ProfileImageKind): Promise<void> {
  const key = keyFromPublicPath(kind, url);
  if (!key) return;

  try {
    await getStorage().deleteObject({ bucket: env.S3_BUCKET, key });
  } catch {
    // Intentionally swallowed. See above.
  }
}

/** Convenience for the controller: store, then point the column at the result. */
export async function replace(
  userId: string,
  kind: ProfileImageKind,
  buffer: Buffer,
  originalName: string,
  declaredMime: string | null,
  previousUrl: string | null,
): Promise<StoredImage> {
  const stored = await store(userId, kind, buffer, originalName, declaredMime);

  await repo.updateImageField(userId, kind === 'avatar' ? 'avatarUrl' : 'coverUrl', stored.url);
  await remove(previousUrl, kind);

  return stored;
}
