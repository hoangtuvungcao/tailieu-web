import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';

import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { documentFiles, storageObjects } from '../../db/schema/index.js';
import { buildDerivedKey } from '../files/mime.js';
import { getStorage } from '../storage/index.js';
import { convertToPdf } from '../../workers/converter/convert.js';

const activeConversions = new Set<string>();

/**
 * On-demand direct conversion for Office documents.
 * Ensures previews render fast (2-3s) without stalling if external worker is delayed.
 */
export async function convertFileDirectly(fileId: string): Promise<boolean> {
  if (activeConversions.has(fileId)) {
    return false;
  }

  activeConversions.add(fileId);

  try {
    const [file] = await db
      .select({
        id: documentFiles.id,
        documentId: documentFiles.documentId,
        originalName: documentFiles.originalName,
        detectedMime: documentFiles.detectedMime,
        previewStatus: documentFiles.previewStatus,
        previewContentHash: documentFiles.previewContentHash,
        contentHash: documentFiles.contentHash,
      })
      .from(documentFiles)
      .where(eq(documentFiles.id, fileId))
      .limit(1);

    if (!file) return false;
    if (file.previewStatus === 'ready' && file.previewContentHash) {
      return true;
    }

    const [storageObj] = await db
      .select({
        bucket: storageObjects.bucket,
        objectKey: storageObjects.objectKey,
      })
      .from(storageObjects)
      .where(eq(storageObjects.contentHash, file.contentHash))
      .limit(1);

    if (!storageObj) return false;

    // Mark processing
    await db
      .update(documentFiles)
      .set({ previewStatus: 'processing', previewError: null })
      .where(eq(documentFiles.id, file.id))
      .catch(() => undefined);

    const storage = getStorage();
    const sourceStream = await storage.getStream({
      bucket: storageObj.bucket,
      key: storageObj.objectKey,
    });

    const chunks: Buffer[] = [];
    for await (const chunk of sourceStream) {
      chunks.push(chunk as Buffer);
    }
    const source = Buffer.concat(chunks);

    const { buffer } = await convertToPdf(source, file.originalName);

    const previewKey = buildDerivedKey(storageObj.objectKey, 'preview', 'pdf');
    const upload = await storage.putStream({
      bucket: env.S3_BUCKET,
      key: previewKey,
      body: Readable.from([buffer]),
      contentType: 'application/pdf',
      metadata: { derivedFrom: file.id, generator: 'direct-converter' },
    });

    const contentHash = Buffer.from(upload.contentHash, 'hex');

    await db.transaction(async (tx) => {
      await tx
        .insert(storageObjects)
        .values({
          contentHash,
          bucket: env.S3_BUCKET,
          objectKey: previewKey,
          sizeBytes: upload.sizeBytes,
          detectedMime: 'application/pdf',
          refCount: 0,
        })
        .onConflictDoNothing({ target: storageObjects.contentHash });

      await tx
        .update(documentFiles)
        .set({
          previewContentHash: contentHash,
          previewStatus: 'ready',
          previewError: null,
        })
        .where(eq(documentFiles.id, file.id));
    });

    return true;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await db
      .update(documentFiles)
      .set({
        previewStatus: 'failed',
        previewError: errorMsg.slice(0, 500),
      })
      .where(eq(documentFiles.id, fileId))
      .catch(() => undefined);
    return false;
  } finally {
    activeConversions.delete(fileId);
  }
}
