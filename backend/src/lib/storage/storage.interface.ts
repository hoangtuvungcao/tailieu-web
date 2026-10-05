import type { Readable } from 'node:stream';

/**
 * Storage abstraction.
 *
 * Every caller in the application depends on this interface, never on the AWS
 * SDK directly. That is what made swapping MinIO for SeaweedFS after MinIO
 * ended community distribution a configuration change rather than a rewrite,
 * and it is what will make a future move to Cloudflare R2 equally cheap.
 *
 * Two rules every implementation must uphold:
 *   1. Streaming only. No method may buffer a whole object in memory — the
 *      process must be able to move a 2GB file inside a 512MB container.
 *   2. Keys are opaque. Nothing outside this layer may construct, parse, or
 *      expose an object key, because a guessable key is an enumeration vector.
 */

export interface ObjectLocation {
  bucket: string;
  key: string;
}

export interface PutStreamOptions {
  bucket: string;
  key: string;
  body: Readable;
  /** Detected MIME, recorded on the object. */
  contentType: string;
  /** Abort the upload if this many bytes have been read. */
  maxBytes?: number;
  /** Extra metadata stored alongside the object. */
  metadata?: Record<string, string>;
}

export interface PutStreamResult {
  /** Hex-encoded sha256 of the bytes actually written. */
  contentHash: string;
  sizeBytes: number;
  etag: string | undefined;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface MultipartInit {
  uploadId: string;
  key: string;
  bucket: string;
}

export interface StorageHealth {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface StorageDriver {
  /** Idempotently create the configured buckets and apply lifecycle rules. */
  ensureBuckets(): Promise<void>;

  /** Stream an object in. Returns the hash and size of what was written. */
  putStream(options: PutStreamOptions): Promise<PutStreamResult>;

  /** Stream an object out. */
  getStream(location: ObjectLocation): Promise<Readable>;

  /** Copy server-side, without the bytes traversing this process. */
  copyObject(source: ObjectLocation, destination: ObjectLocation): Promise<void>;

  deleteObject(location: ObjectLocation): Promise<void>;

  objectExists(location: ObjectLocation): Promise<boolean>;

  objectSize(location: ObjectLocation): Promise<number | null>;

  /**
   * A time-limited URL granting read access to exactly one object.
   *
   * This is the only way bytes leave the system. It is a bearer credential,
   * so the TTL must stay short — long enough for a download to start, short
   * enough that a leaked URL expires before it is useful.
   */
  signedDownloadUrl(
    location: ObjectLocation,
    options?: { expiresInSeconds?: number; downloadFilename?: string; contentType?: string },
  ): Promise<string>;

  // --- Multipart, used by the chunked upload protocol ------------------------

  createMultipartUpload(options: {
    bucket: string;
    key: string;
    contentType: string;
    metadata?: Record<string, string>;
  }): Promise<MultipartInit>;

  uploadPart(options: {
    bucket: string;
    key: string;
    uploadId: string;
    /** 1-based, matching the S3 API. */
    partNumber: number;
    body: Readable;
    /** Reject a part whose actual size differs from this. */
    expectedBytes?: number;
  }): Promise<CompletedPart>;

  completeMultipartUpload(options: {
    bucket: string;
    key: string;
    uploadId: string;
    parts: CompletedPart[];
  }): Promise<void>;

  abortMultipartUpload(options: {
    bucket: string;
    key: string;
    uploadId: string;
  }): Promise<void>;

  healthCheck(): Promise<StorageHealth>;
}
