import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

import { env } from '../config/env.js';
import { AppError } from './errors.js';

/**
 * Media tokens.
 *
 * A `<img>`, an `<object>` and an `<a download>` cannot send an Authorization
 * header, so a URL that only the browser can fetch has to carry its own proof
 * of authorization. That is what this is — and it exists because the
 * alternative, handing the browser a signed URL on the storage origin, puts
 * every preview and download in a third-party context. Chrome partitions
 * storage for those and logs a "Partitioned cookie or storage access" warning
 * on every single one.
 *
 * WHAT MAKES IT SAFE
 *
 *   IT IS A SEPARATE AUDIENCE. These are signed with the same secret as access
 *   tokens but carry `aud: media`, and verification pins that audience. An
 *   access token presented here fails, and a media token presented to the API
 *   as a bearer token fails. Sharing a secret is fine; sharing an audience is
 *   what would let one be replayed as the other.
 *
 *   IT NAMES ONE FILE. The claims carry the file id, and the route checks them
 *   against the file it was asked for. A token for document A cannot fetch
 *   document B by editing the URL.
 *
 *   IT IS SHORT-LIVED BUT NOT TOO SHORT. Long enough for a PDF viewer to issue
 *   its range requests over a slow connection, short enough that a URL copied
 *   out of a devtools panel stops working while the person is still looking at
 *   it. It is not single-use: a PDF viewer legitimately fetches the same file
 *   many times, and rejecting the second request would break the very thing
 *   this exists to enable.
 *
 *   IT GRANTS NO NEW AUTHORITY. It is only ever minted by a route that has
 *   already decided the caller may read the file, and it records that decision
 *   for a few minutes rather than re-deciding it. Nothing about it lets a
 *   caller read something the minting route would have refused.
 */

const secretKey = new TextEncoder().encode(env.JWT_SECRET);
const MEDIA_AUDIENCE = 'media';

export interface MediaTokenClaims {
  /** The file the token is good for. */
  fileId: string;
  /** The owning document, so the route can refuse a mismatched pair. */
  documentId: string;
}

/**
 * Ten minutes. Deliberately not `S3_SIGNED_URL_TTL_SECONDS`: that TTL is tuned
 * for a redirect that starts a download immediately, whereas this one has to
 * outlive a reader scrolling through a 200-page PDF.
 */
const MEDIA_TOKEN_TTL = '10m';

/** The same lifetime in seconds, for the `expiresInSeconds` a client is told. */
export const MEDIA_TOKEN_TTL_SECONDS = 600;

export async function signMediaToken(claims: MediaTokenClaims): Promise<string> {
  return new SignJWT({ fid: claims.fileId, did: claims.documentId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(env.JWT_ISSUER)
    .setAudience(MEDIA_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(MEDIA_TOKEN_TTL)
    .sign(secretKey);
}

export async function verifyMediaToken(token: string): Promise<MediaTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secretKey, {
      issuer: env.JWT_ISSUER,
      audience: MEDIA_AUDIENCE,
      algorithms: ['HS256'],
    });

    if (typeof payload.fid !== 'string' || typeof payload.did !== 'string') {
      throw new AppError('MEDIA_TOKEN_INVALID', 'Liên kết xem tệp không hợp lệ.');
    }

    return { fileId: payload.fid, documentId: payload.did };
  } catch (error) {
    if (error instanceof AppError) throw error;

    if (error instanceof joseErrors.JWTExpired) {
      throw new AppError(
        'MEDIA_TOKEN_EXPIRED',
        'Liên kết xem tệp đã hết hạn. Vui lòng mở lại tài liệu.',
      );
    }

    throw new AppError('MEDIA_TOKEN_INVALID', 'Liên kết xem tệp không hợp lệ.', { cause: error });
  }
}
