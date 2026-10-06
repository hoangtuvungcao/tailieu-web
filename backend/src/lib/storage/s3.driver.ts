import { Readable, Transform } from 'node:stream';

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
  UploadPartCommand,
  type CompletedPart as S3CompletedPart,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';

import { env } from '../../config/env.js';
import { contentDisposition } from '../http/content-disposition.js';
import { HashTee } from '../streams/hash-tee.js';
import type {
  CompletedPart,
  GetStreamOptions,
  MultipartInit,
  ObjectLocation,
  PutStreamOptions,
  PutStreamResult,
  StorageDriver,
  StorageHealth,
} from './storage.interface.js';

/**
 * S3-compatible storage driver.
 *
 * Works against SeaweedFS (local), Cloudflare R2, AWS S3, Backblaze B2, or any
 * other S3-compatible endpoint. The only differences between them are config:
 * `S3_FORCE_PATH_STYLE` and the endpoint URL.
 *
 * Streaming discipline: no method here ever calls `transformToByteArray()`,
 * `Buffer.concat`, or any other buffering helper. Everything moves as a
 * stream, which is what keeps memory flat regardless of file size.
 */
export class S3StorageDriver implements StorageDriver {
  private readonly client: S3Client;

  constructor() {
    this.client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY,
        secretAccessKey: env.S3_SECRET_KEY,
      },
      // SeaweedFS and MinIO require path-style (`endpoint/bucket/key`);
      // R2 and AWS expect virtual-hosted style (`bucket.endpoint/key`).
      // Choosing wrong yields SignatureDoesNotMatch, not a helpful error.
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      // Large parts over a home connection benefit from retrying rather than
      // failing the whole upload.
      maxAttempts: 3,
      // S3-compatible stores like SeaweedFS do not support aws-chunked streaming
      // checksum trailers, which otherwise inflate files by appending chunk frames.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  get raw(): S3Client {
    return this.client;
  }

  /**
   * Create the buckets if absent and apply the incomplete-multipart lifecycle
   * rule.
   *
   * Provisioning lives here rather than in a shell script so that the same
   * code path works against R2 — where the credentials may not permit bucket
   * administration at all, in which case a failure is logged and tolerated
   * because the bucket is expected to pre-exist.
   */
  async ensureBuckets(): Promise<void> {
    for (const bucket of [env.S3_BUCKET, env.S3_STAGING_BUCKET]) {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
        if (status === 404 || status === 403 || status === undefined) {
          try {
            await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
            console.info(`[storage] created bucket "${bucket}"`);
          } catch (createError) {
            // On R2 the token often cannot create buckets. The bucket is
            // expected to exist already, so do not fail startup over this.
            console.warn(
              `[storage] could not create bucket "${bucket}":`,
              (createError as Error).message,
            );
            continue;
          }
        } else {
          throw error;
        }
      }

      // A failed upload that is never aborted leaves multipart parts on the
      // backend consuming storage forever, invisible to every listing because
      // incomplete uploads do not appear as objects. Expire them after a day.
      try {
        await this.client.send(
          new PutBucketLifecycleConfigurationCommand({
            Bucket: bucket,
            LifecycleConfiguration: {
              Rules: [
                {
                  ID: 'abort-incomplete-multipart-uploads',
                  Status: 'Enabled',
                  Filter: { Prefix: '' },
                  AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
                },
              ],
            },
          }),
        );
      } catch (error) {
        // Not fatal: some S3-compatible backends do not implement lifecycle
        // config. The reaper job is the backstop.
        console.warn(
          `[storage] could not set lifecycle rule on "${bucket}":`,
          (error as Error).message,
        );
      }
    }
  }

  async putStream(options: PutStreamOptions): Promise<PutStreamResult> {
    const tee = new HashTee(options.maxBytes);
    const body = options.body.pipe(tee);

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: options.bucket,
        Key: options.key,
        Body: body,
        ContentType: options.contentType,
        Metadata: options.metadata,
      },
      // 8MB parts on the wire. Large enough to amortize request overhead,
      // small enough to stay responsive on a slow connection.
      partSize: 8 * 1024 * 1024,
      queueSize: 2,
      leavePartsOnError: false,
    });

    try {
      const result = await upload.done();
      return {
        contentHash: tee.digest(),
        sizeBytes: tee.bytes,
        etag: (result as { ETag?: string }).ETag,
      };
    } catch (error) {
      // Abort so a failed upload leaves nothing behind. Without this, every
      // rejected file silently consumes backend storage forever.
      await upload.abort().catch(() => undefined);
      throw error;
    }
  }

  async getStream(location: ObjectLocation, options?: GetStreamOptions): Promise<Readable> {
    const range = options?.range;
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: location.bucket,
        Key: location.key,
        // S3's range header is inclusive at both ends and uses `bytes=0-` for
        // "to the end", so an absent `end` must not become a literal `-0`.
        ...(range
          ? { Range: `bytes=${range.start}-${range.end ?? ''}` }
          : {}),
      }),
    );
    if (!response.Body) {
      throw new Error(`Object ${location.bucket}/${location.key} returned an empty body.`);
    }
    // In Node the SDK returns a Readable; the cast covers the browser union type.
    return response.Body as Readable;
  }

  async copyObject(source: ObjectLocation, destination: ObjectLocation): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: destination.bucket,
        Key: destination.key,
        CopySource: `${source.bucket}/${encodeURIComponent(source.key)}`,
      }),
    );
  }

  async deleteObject(location: ObjectLocation): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: location.bucket, Key: location.key }),
    );
  }

  async objectExists(location: ObjectLocation): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: location.bucket, Key: location.key }),
      );
      return true;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (status === 404) return false;
      throw error;
    }
  }

  async objectSize(location: ObjectLocation): Promise<number | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: location.bucket, Key: location.key }),
      );
      return head.ContentLength ?? null;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw error;
    }
  }

  async signedDownloadUrl(
    location: ObjectLocation,
    options?: { expiresInSeconds?: number; downloadFilename?: string; contentType?: string },
  ): Promise<string> {
    const expiresIn = options?.expiresInSeconds ?? env.S3_SIGNED_URL_TTL_SECONDS;

    const command = new GetObjectCommand({
      Bucket: location.bucket,
      Key: location.key,
      ...(options?.contentType ? { ResponseContentType: options.contentType } : {}),
      ...(options?.downloadFilename
        ? { ResponseContentDisposition: contentDisposition(options.downloadFilename, 'attachment') }
        : {}),
    });

    return getSignedUrl(this.client, command, { expiresIn });
  }

  // --- Multipart -------------------------------------------------------------

  async createMultipartUpload(options: {
    bucket: string;
    key: string;
    contentType: string;
    metadata?: Record<string, string>;
  }): Promise<MultipartInit> {
    const response = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: options.bucket,
        Key: options.key,
        ContentType: options.contentType,
        Metadata: options.metadata,
      }),
    );

    if (!response.UploadId) {
      throw new Error('Storage backend did not return an upload id for the multipart upload.');
    }

    return { uploadId: response.UploadId, key: options.key, bucket: options.bucket };
  }

  async uploadPart(options: {
    bucket: string;
    key: string;
    uploadId: string;
    partNumber: number;
    body: Readable;
    expectedBytes?: number;
  }): Promise<CompletedPart> {
    // Count bytes as they pass so a truncated or oversized part is caught here
    // rather than producing a silently corrupt assembled file.
    let bytes = 0;
    const counting = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(null, chunk);
      },
    });

    try {
      const response = await this.client.send(
        new UploadPartCommand({
          Bucket: options.bucket,
          Key: options.key,
          UploadId: options.uploadId,
          PartNumber: options.partNumber,
          Body: options.body.pipe(counting),
          // Signals a non-seekable stream so the SDK does not attempt to
          // compute a Content-Length by buffering.
          ContentLength: options.expectedBytes,
        }),
      );

      if (options.expectedBytes !== undefined && bytes !== options.expectedBytes) {
        throw new Error(
          `Chunk ${options.partNumber} was declared as ${options.expectedBytes} bytes but ${bytes} arrived.`,
        );
      }

      if (!response.ETag) {
        throw new Error(`Storage backend returned no ETag for chunk ${options.partNumber}.`);
      }

      return { partNumber: options.partNumber, etag: response.ETag };
    } finally {
      // Ensure the source stream is released even on the error path, otherwise
      // the request socket stays open until the client gives up.
      options.body.destroy();
    }
  }

  async completeMultipartUpload(options: {
    bucket: string;
    key: string;
    uploadId: string;
    parts: CompletedPart[];
  }): Promise<void> {
    // S3 requires parts in ascending order; an out-of-order list produces
    // InvalidPartOrder, and with concurrent chunk uploads the arrival order is
    // not the index order.
    const parts: S3CompletedPart[] = [...options.parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag }));

    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: options.bucket,
        Key: options.key,
        UploadId: options.uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
  }

  async abortMultipartUpload(options: {
    bucket: string;
    key: string;
    uploadId: string;
  }): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: options.bucket,
        Key: options.key,
        UploadId: options.uploadId,
      }),
    );
  }

  async healthCheck(): Promise<StorageHealth> {
    const started = process.hrtime.bigint();
    try {
      // HeadBucket exercises credentials and reachability in one call, which is
      // what actually matters — a reachable endpoint with bad credentials is
      // still a broken storage tier.
      await this.client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
      const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      return { ok: true, latencyMs: Math.round(latencyMs * 100) / 100 };
    } catch (error) {
      const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      return {
        ok: false,
        latencyMs: Math.round(latencyMs * 100) / 100,
        error: (error as Error).name,
      };
    }
  }
}
