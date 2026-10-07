import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';

import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { documentFiles, documents, storageObjects } from '../../db/schema/index.js';
import { buildDerivedKey } from '../files/mime.js';
import { needsConversion } from './preview.resolver.js';
import { isRasterizerAvailable, rasterizePdfToImages } from './rasterizer.js';
import { getStorage } from '../storage/index.js';
import { convertToPdf } from '../../workers/converter/convert.js';

const activeConversions = new Set<string>();

/**
 * On-demand direct conversion and page rasterization for documents.
 * 1. For Office docs: converts to PDF via LibreOffice (2-3s).
 * 2. For both Office & Native PDFs: renders pages into ultra-fast ~40KB JPEGs via pdftoppm.
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
        pageCount: documentFiles.pageCount,
        isPrimary: documentFiles.isPrimary,
      })
      .from(documentFiles)
      .where(eq(documentFiles.id, fileId))
      .limit(1);

    if (!file) return false;

    const [storageObj] = await db
      .select({
        bucket: storageObjects.bucket,
        objectKey: storageObjects.objectKey,
      })
      .from(storageObjects)
      .where(eq(storageObjects.contentHash, file.contentHash))
      .limit(1);

    if (!storageObj) return false;

    const storage = getStorage();
    let pdfBuffer: Buffer | null = null;
    let convertedContentHash: Buffer | null = file.previewContentHash;

    const isOffice = needsConversion(file.detectedMime, file.originalName);
    const isPdf =
      file.detectedMime === 'application/pdf' ||
      file.originalName.toLowerCase().endsWith('.pdf');

    if (isOffice) {
      if (file.previewStatus === 'ready' && file.previewContentHash) {
        // PDF artifact already exists, retrieve it for rasterizing pages if not done yet
        if (!file.pageCount || file.pageCount === 0) {
          const previewKey = buildDerivedKey(storageObj.objectKey, 'preview', 'pdf');
          try {
            const stream = await storage.getStream({ bucket: storageObj.bucket, key: previewKey });
            const chunks: Buffer[] = [];
            for await (const chunk of stream) chunks.push(chunk as Buffer);
            pdfBuffer = Buffer.concat(chunks);
          } catch {
            pdfBuffer = null;
          }
        }
      }

      if (!pdfBuffer && file.previewStatus !== 'ready') {
        // Mark processing
        await db
          .update(documentFiles)
          .set({ previewStatus: 'processing', previewError: null })
          .where(eq(documentFiles.id, file.id))
          .catch(() => undefined);

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
        pdfBuffer = buffer;

        const previewKey = buildDerivedKey(storageObj.objectKey, 'preview', 'pdf');
        const upload = await storage.putStream({
          bucket: env.S3_BUCKET,
          key: previewKey,
          body: Readable.from([buffer]),
          contentType: 'application/pdf',
          metadata: { derivedFrom: file.id, generator: 'direct-converter' },
        });

        convertedContentHash = Buffer.from(upload.contentHash, 'hex');

        await db.transaction(async (tx) => {
          await tx
            .insert(storageObjects)
            .values({
              contentHash: convertedContentHash!,
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
              previewContentHash: convertedContentHash,
              previewStatus: 'ready',
              previewError: null,
            })
            .where(eq(documentFiles.id, file.id));
        });
      }
    } else if (isPdf) {
      if (!file.pageCount || file.pageCount === 0) {
        const sourceStream = await storage.getStream({
          bucket: storageObj.bucket,
          key: storageObj.objectKey,
        });
        const chunks: Buffer[] = [];
        for await (const chunk of sourceStream) {
          chunks.push(chunk as Buffer);
        }
        pdfBuffer = Buffer.concat(chunks);
      }
    }

    // Rasterize pages to lightweight ~40KB JPEGs if rasterizer is available
    if (pdfBuffer && (!file.pageCount || file.pageCount === 0)) {
      const rasterAvailable = await isRasterizerAvailable();
      if (rasterAvailable) {
        try {
          const pages = await rasterizePdfToImages(pdfBuffer, 30);
          if (pages.length > 0) {
            for (const page of pages) {
              const pageKey = buildDerivedKey(storageObj.objectKey, `page${page.pageNum}`, 'jpg');
              const pageUpload = await storage.putStream({
                bucket: env.S3_BUCKET,
                key: pageKey,
                body: Readable.from([page.buffer]),
                contentType: 'image/jpeg',
                metadata: { derivedFrom: file.id, pageNum: String(page.pageNum) },
              });
              const pageContentHash = Buffer.from(pageUpload.contentHash, 'hex');
              await db
                .insert(storageObjects)
                .values({
                  contentHash: pageContentHash,
                  bucket: env.S3_BUCKET,
                  objectKey: pageKey,
                  sizeBytes: pageUpload.sizeBytes,
                  detectedMime: 'image/jpeg',
                  refCount: 0,
                })
                .onConflictDoNothing({ target: storageObjects.contentHash })
                .catch(() => undefined);
            }

            await db
              .update(documentFiles)
              .set({ pageCount: pages.length })
              .where(eq(documentFiles.id, file.id));

            if (file.isPrimary) {
              await db
                .update(documents)
                .set({ pageCount: pages.length })
                .where(eq(documents.id, file.documentId))
                .catch(() => undefined);
            }
          }
        } catch (rasterErr) {
          console.error('[direct-converter] Rasterization error:', rasterErr);
        }
      }
    }

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
