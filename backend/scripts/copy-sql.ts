/**
 * Copy the SQL bootstrap files into dist after a build.
 *
 * Replaces `mkdir -p dist/db/sql && cp -R src/db/sql/. dist/db/sql/`, which is
 * bash. `tsc` does not copy non-TypeScript assets, so without this step a
 * production build fails at migration time with "Could not locate SQL bootstrap
 * files" — which reads as a deployment problem rather than a missing build step.
 */
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, '..');
const from = path.join(backendRoot, 'src', 'db', 'sql');
const to = path.join(backendRoot, 'dist', 'db', 'sql');

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
console.log(`Copied SQL bootstrap files to ${path.relative(backendRoot, to)}`);
