import { z } from 'zod';

/**
 * Opaque keyset cursors.
 *
 * The encoding is `base64url("<iso>|<uuid>")`, and the point of encoding it at
 * all is that a client should not be able to construct one. A hand-built cursor
 * is a way to ask the server for a page starting from a row the reader was
 * never shown — and an encoding that callers depend on cannot be changed later
 * without breaking them.
 *
 * Decoding validates shape rather than trusting it. A malformed cursor reaching
 * the query would be a cast error from Postgres, which surfaces as a 500 for
 * what is really a bad request.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const cursorSchema = z.string().trim().min(1).max(200);

export interface Cursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(createdAt: Date | string, id: string): string {
  const iso =
    createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString();
  return Buffer.from(`${iso}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  // `lastIndexOf`, because the ISO timestamp contains no `|` but being
  // forgiving about the separator costs nothing and avoids a whole class of
  // off-by-one decode bugs.
  const separator = decoded.lastIndexOf('|');
  if (separator === -1) return null;

  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);

  if (Number.isNaN(Date.parse(createdAt))) return null;
  if (!UUID_RE.test(id)) return null;

  return { createdAt, id };
}
