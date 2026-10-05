/**
 * The URL scheme for publicly served media.
 *
 * One module owns the mapping between a public path and a storage key, because
 * the two have to agree exactly: the writer decides the path, the reader parses
 * it back, and the delete path recovers the key from what is stored in the
 * column. Three implementations of that string manipulation would eventually
 * disagree, and the failure mode is either a broken image or — worse — a
 * delete aimed at the wrong object.
 *
 * WHAT MAY LIVE HERE
 *
 * Only media that is public by definition: profile avatars and cover images.
 * Anything whose readability depends on who is asking must not be reachable
 * through this scheme, because the paths carry no signature and the route
 * applies no permission check. Document content is served by its own route
 * with a scoped token, and its key never appears in a URL.
 *
 * The path embeds the storage key. That is acceptable here precisely because
 * the key contains a UUID — it is unguessable, and the object behind it is
 * public anyway. The storage layer's rule that keys are opaque exists to stop
 * *enumeration*, and a random UUID does not enumerate.
 */

export type PublicMediaKind = 'avatars' | 'covers';

export const PUBLIC_MEDIA_KINDS: readonly PublicMediaKind[] = ['avatars', 'covers'];

/** Content type per extension. The reader trusts the extension it validated. */
export const MIME_BY_MEDIA_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * `<kind>/<user uuid>/<image uuid>.<ext>`.
 *
 * The two UUIDs are separately shaped rather than one loose pattern so a path
 * like `avatars/../../documents/2026/10/x.png` cannot pass: every segment is
 * fixed-width hex, and there is no way to spell `..` inside one.
 */
const SAFE_KEY = /^(avatars|covers)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif)$/;

/** URL path prefix every public media path begins with. */
export const MEDIA_PATH_PREFIX = '/api/v1/media/';

export function isSafeMediaKey(key: string): boolean {
  return SAFE_KEY.test(key);
}

export function mediaPublicPath(key: string): string {
  return `${MEDIA_PATH_PREFIX}${key}`;
}

/**
 * The storage key a public path points at, or null.
 *
 * Null for anything unrecognised, and the callers treat null as "not ours".
 * That is the safe default in both directions: a reader answers 404 rather
 * than reading an arbitrary object, and a delete does nothing rather than
 * removing something it does not own.
 */
export function mediaKeyFromPath(path: string): string | null {
  if (!path.startsWith(MEDIA_PATH_PREFIX)) return null;
  const key = path.slice(MEDIA_PATH_PREFIX.length);
  return isSafeMediaKey(key) ? key : null;
}

/** Content type for a key, or null when the extension is not one we serve. */
export function mediaContentType(key: string): string | null {
  const extension = key.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_MEDIA_EXTENSION[extension] ?? null;
}
