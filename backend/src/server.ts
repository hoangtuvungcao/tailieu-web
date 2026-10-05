import { buildApp } from './app.js';
import { env } from './config/env.js';
import { closeDatabase } from './db/client.js';
import { closeRedis } from './db/redis.js';
import { getStorage } from './lib/storage/index.js';

/**
 * Process entry point.
 *
 * Startup order is deliberate: storage is provisioned BEFORE the server
 * accepts traffic, because an upload that fails against a missing bucket looks
 * like a bug in the upload code rather than a provisioning gap. A failure here
 * is logged and tolerated only where it is genuinely optional (bucket
 * lifecycle rules on a backend that does not implement them).
 */
async function main(): Promise<void> {
  const app = await buildApp();

  try {
    await getStorage().ensureBuckets();
  } catch (error) {
    // Not fatal: the buckets may be pre-provisioned by an operator, or the
    // credentials may deliberately lack bucket-admin rights (common on
    // Cloudflare R2). Uploads will surface a clear storage error if the
    // buckets really are missing.
    app.log.warn({ err: error }, 'storage provisioning incomplete — continuing');
  }

  await app.listen({ port: env.API_PORT, host: env.API_HOST });

  app.log.info(
    { port: env.API_PORT, env: env.NODE_ENV, publicUrl: env.API_PUBLIC_URL },
    'TAILIEU TTN API listening',
  );

  // --- Graceful shutdown -----------------------------------------------------
  // Closing cleanly matters more than usual here: an abrupt exit mid-upload
  // leaves an incomplete S3 multipart upload, and an abrupt exit mid-request
  // leaves a client believing a document was saved when it was not.
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    app.log.info({ signal }, 'shutting down');

    // Stop accepting new connections and let in-flight requests finish. The
    // timeout bounds how long a stuck request can delay exit.
    const forceExit = setTimeout(() => {
      app.log.error('shutdown timed out; exiting forcefully');
      process.exit(1);
    }, 15_000);
    forceExit.unref();

    try {
      await app.close();
      await closeDatabase();
      await closeRedis();
      clearTimeout(forceExit);
      app.log.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  // --- Last-resort handlers --------------------------------------------------
  // A rejected promise with no handler would otherwise terminate the process
  // silently in newer Node versions, taking every in-flight request with it.
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandled promise rejection');
  });

  process.on('uncaughtException', (error) => {
    app.log.fatal({ err: error }, 'uncaught exception — shutting down');
    void shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  // The logger may not exist yet if configuration or plugin registration
  // failed, so this writes to stderr directly.
  console.error('Failed to start the API:\n', error);
  process.exit(1);
});
