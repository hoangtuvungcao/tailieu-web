import { S3StorageDriver } from './s3.driver.js';
import type { StorageDriver } from './storage.interface.js';

export * from './storage.interface.js';
export { S3StorageDriver } from './s3.driver.js';

/**
 * Process-wide storage driver.
 *
 * Lazily constructed so that importing a module which transitively touches
 * storage does not require S3 credentials to be valid at import time — the
 * seed scripts and unit tests import plenty of things they never exercise.
 */
let instance: StorageDriver | null = null;

export function getStorage(): StorageDriver {
  instance ??= new S3StorageDriver();
  return instance;
}

/** Test hook: swap in a fake driver without touching module state globally. */
export function setStorage(driver: StorageDriver | null): void {
  instance = driver;
}
