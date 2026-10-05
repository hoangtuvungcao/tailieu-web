import { createHash, type Hash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

/**
 * Error thrown when a stream exceeds its permitted size.
 *
 * Distinguished from a generic error because callers map it to HTTP 413, and
 * because it must trigger an abort of any in-flight multipart upload — an
 * abandoned multipart upload leaks parts on the storage backend forever.
 */
export class StreamTooLargeError extends Error {
  readonly code = 'FILE_TOO_LARGE';
  constructor(
    readonly limitBytes: number,
    readonly bytesSeen: number,
  ) {
    super(
      `Upload exceeded the ${limitBytes} byte limit (saw at least ${bytesSeen} bytes).`,
    );
    this.name = 'StreamTooLargeError';
  }
}

/**
 * Pass-through transform that hashes and counts bytes as they flow.
 *
 * This is what lets the server compute a sha256 for content-addressed dedup
 * without ever holding the file in memory: chunks are hashed on the way past
 * and immediately released. A naive implementation that awaits a buffer first
 * would cap upload size at available RAM and turn a 2GB thesis into an OOM.
 *
 * The size limit is enforced here, mid-stream, rather than by trusting
 * `Content-Length` — a client can lie about that header, and chunked transfer
 * encoding does not send one at all.
 */
export class HashTee extends Transform {
  private readonly hash: Hash = createHash('sha256');
  private bytesSeen = 0;
  private finished = false;

  constructor(private readonly maxBytes?: number) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytesSeen += chunk.length;

    if (this.maxBytes !== undefined && this.bytesSeen > this.maxBytes) {
      callback(new StreamTooLargeError(this.maxBytes, this.bytesSeen));
      return;
    }

    this.hash.update(chunk);
    callback(null, chunk);
  }

  get bytes(): number {
    return this.bytesSeen;
  }

  /** Hex sha256 of everything that passed through. Callable once. */
  digest(): string {
    if (this.finished) {
      throw new Error('HashTee.digest() called twice; the hash was already consumed.');
    }
    this.finished = true;
    return this.hash.digest('hex');
  }

  /** sha256 as raw bytes, which is how it is stored in the database. */
  digestBuffer(): Buffer {
    if (this.finished) {
      throw new Error('HashTee.digestBuffer() called twice; the hash was already consumed.');
    }
    this.finished = true;
    return this.hash.digest();
  }
}
