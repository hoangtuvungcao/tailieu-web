/**
 * Storage smoke test.
 *
 * Verifies the S3 path end to end against whatever backend S3_ENDPOINT points
 * at: bucket provisioning, streamed upload with hashing, multipart assembly
 * (the chunked-upload path), object retrieval, and signed URLs.
 *
 * Run with: npx tsx src/scripts/storage-smoke.ts
 *
 * This exists because "it should work against any S3-compatible backend" is a
 * claim that silently stops being true the moment you switch providers —
 * path-style addressing, ETag formats and lifecycle support all differ. Run
 * this after any storage configuration change.
 */
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

import { env } from '../config/env.js';
import { getStorage } from '../lib/storage/index.js';

const results: { name: string; ok: boolean; detail: string }[] = [];

function record(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function streamOf(data: Buffer): Readable {
  return Readable.from([data]);
}

async function main(): Promise<void> {
  const storage = getStorage();
  const key = `smoke/${randomUUID()}`;
  const bucket = env.S3_BUCKET;

  console.log(`\nStorage smoke test against ${env.S3_ENDPOINT} (bucket "${bucket}")\n`);

  // --- provisioning ---------------------------------------------------------
  try {
    await storage.ensureBuckets();
    record('ensureBuckets (create buckets + lifecycle rule)', true);
  } catch (error) {
    record('ensureBuckets (create buckets + lifecycle rule)', false, (error as Error).message);
    // Without buckets nothing else can pass; stop early with a clear reason.
    summarize();
    return;
  }

  // --- health ---------------------------------------------------------------
  const health = await storage.healthCheck();
  record('healthCheck', health.ok, health.ok ? `${health.latencyMs}ms` : health.error);

  // --- streamed upload with hashing ----------------------------------------
  // Deliberately multi-byte UTF-8 so a naive byte/string mix-up shows up.
  const payload = Buffer.from('Bài giảng Lập trình C++ — nội dung thử nghiệm. '.repeat(500), 'utf8');
  const expectedHash = createHash('sha256').update(payload).digest('hex');

  let uploadedHash = '';
  try {
    const result = await storage.putStream({
      bucket,
      key,
      body: streamOf(payload),
      contentType: 'text/plain; charset=utf-8',
    });
    uploadedHash = result.contentHash;
    record(
      'putStream returns correct size',
      result.sizeBytes === payload.length,
      `${result.sizeBytes} vs ${payload.length}`,
    );
    record(
      'putStream returns correct sha256',
      result.contentHash === expectedHash,
      result.contentHash.slice(0, 16) + '…',
    );
  } catch (error) {
    record('putStream', false, (error as Error).message);
  }

  // --- existence and size ---------------------------------------------------
  record('objectExists (present)', await storage.objectExists({ bucket, key }));
  record('objectExists (absent)', !(await storage.objectExists({ bucket, key: `${key}-nope` })));
  record('objectSize', (await storage.objectSize({ bucket, key })) === payload.length);

  // --- download and verify bytes -------------------------------------------
  try {
    const stream = await storage.getStream({ bucket, key });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const roundTripped = Buffer.concat(chunks);
    record(
      'getStream round-trips bytes exactly',
      roundTripped.equals(payload),
      `${roundTripped.length} bytes`,
    );
  } catch (error) {
    record('getStream round-trips bytes exactly', false, (error as Error).message);
  }

  // --- signed URL -----------------------------------------------------------
  try {
    const url = await storage.signedDownloadUrl(
      { bucket, key },
      { expiresInSeconds: 60, downloadFilename: 'Bài giảng C++.txt' },
    );
    const response = await fetch(url);
    const body = Buffer.from(await response.arrayBuffer());
    record('signedDownloadUrl fetches the object', response.ok && body.equals(payload), `HTTP ${response.status}`);

    const disposition = response.headers.get('content-disposition') ?? '';
    record(
      'Content-Disposition carries RFC 5987 UTF-8 filename',
      disposition.includes("filename*=UTF-8''") && response.ok,
      disposition.slice(0, 70),
    );
  } catch (error) {
    record('signedDownloadUrl', false, (error as Error).message);
  }

  // --- multipart: the chunked-upload path ----------------------------------
  // This is what a real document upload uses, so a failure here means chunked
  // upload is broken even if simple uploads work.
  const mpKey = `smoke/multipart/${randomUUID()}`;
  try {
    const init = await storage.createMultipartUpload({
      bucket,
      key: mpKey,
      contentType: 'application/octet-stream',
    });

    const chunkSize = 5 * 1024 * 1024;
    const chunks = [
      Buffer.alloc(chunkSize, 1),
      Buffer.alloc(chunkSize, 2),
      Buffer.alloc(1234, 3),
    ];

    const parts = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const part = await storage.uploadPart({
        bucket,
        key: mpKey,
        uploadId: init.uploadId,
        partNumber: i + 1,
        body: streamOf(chunks[i]!),
        expectedBytes: chunks[i]!.length,
      });
      parts.push(part);
    }

    // Complete out of order on purpose: real concurrent uploads finish in
    // arbitrary order, and S3 rejects an unsorted part list with
    // InvalidPartOrder. The driver must sort them.
    await storage.completeMultipartUpload({
      bucket,
      key: mpKey,
      uploadId: init.uploadId,
      parts: [...parts].reverse(),
    });

    const expectedSize = chunks.reduce((sum, c) => sum + c.length, 0);
    const assembledSize = await storage.objectSize({ bucket, key: mpKey });
    record(
      'multipart assembles chunks (out-of-order completion)',
      assembledSize === expectedSize,
      `${assembledSize} vs ${expectedSize}`,
    );
  } catch (error) {
    record('multipart assembles chunks (out-of-order completion)', false, (error as Error).message);
  }

  // --- part size mismatch must be rejected ---------------------------------
  try {
    const init = await storage.createMultipartUpload({
      bucket,
      key: `smoke/mismatch/${randomUUID()}`,
      contentType: 'application/octet-stream',
    });
    let rejected = false;
    try {
      await storage.uploadPart({
        bucket,
        key: init.key,
        uploadId: init.uploadId,
        partNumber: 1,
        body: streamOf(Buffer.alloc(100)),
        expectedBytes: 999_999,
      });
    } catch {
      rejected = true;
    }
    await storage.abortMultipartUpload({ bucket, key: init.key, uploadId: init.uploadId });
    record('uploadPart rejects a size mismatch', rejected);
  } catch (error) {
    record('uploadPart rejects a size mismatch', false, (error as Error).message);
  }

  // --- cleanup --------------------------------------------------------------
  await storage.deleteObject({ bucket, key }).catch(() => undefined);
  await storage.deleteObject({ bucket, key: mpKey }).catch(() => undefined);

  summarize();
}

function summarize(): void {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log('Storage backend is fully functional.');
  }
}

main().catch((error: unknown) => {
  console.error('\nSmoke test crashed:', error);
  process.exitCode = 1;
});
