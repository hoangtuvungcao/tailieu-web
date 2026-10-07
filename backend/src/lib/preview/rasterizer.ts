import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface RasterizedPage {
  pageNum: number;
  buffer: Buffer;
}

function findFileRecursive(dir: string, filename: string, maxDepth = 4): string | null {
  if (!existsSync(dir) || maxDepth < 0) return null;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
        return full;
      }
      if (entry.isDirectory()) {
        const found = findFileRecursive(full, filename, maxDepth - 1);
        if (found) return found;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Locate pdftoppm executable across Windows and Linux.
 */
export function getPdftoppmBinary(): string {
  if (process.env.PDFTOPPM_PATH && existsSync(process.env.PDFTOPPM_PATH)) {
    return process.env.PDFTOPPM_PATH;
  }

  if (process.platform === 'win32') {
    const directCandidates = [
      'C:\\tailieu\\bin\\poppler\\poppler-24.02.0\\Library\\bin\\pdftoppm.exe',
      'C:\\tailieu\\bin\\poppler\\poppler-24.02.0\\bin\\pdftoppm.exe',
      'C:\\tailieu\\bin\\poppler\\Library\\bin\\pdftoppm.exe',
      'C:\\tailieu\\bin\\poppler\\bin\\pdftoppm.exe',
      'C:\\tailieu\\bin\\poppler\\pdftoppm.exe',
      'C:\\Program Files\\poppler\\bin\\pdftoppm.exe',
      'C:\\Program Files\\poppler\\Library\\bin\\pdftoppm.exe',
      'C:\\tools\\poppler\\bin\\pdftoppm.exe',
    ];
    for (const c of directCandidates) {
      if (existsSync(c)) return c;
    }

    const baseDirs = ['C:\\tailieu\\bin\\poppler', 'C:\\tailieu\\bin', 'C:\\Program Files\\poppler'];
    for (const base of baseDirs) {
      const found = findFileRecursive(base, 'pdftoppm.exe');
      if (found) return found;
    }

    return 'pdftoppm.exe';
  }

  return 'pdftoppm';
}

let cachedAvailability: boolean | null = null;
let lastCheckTime = 0;

/**
 * Check if pdftoppm is available on the system.
 */
export async function isRasterizerAvailable(): Promise<boolean> {
  if (cachedAvailability === true) return true;

  const now = Date.now();
  if (cachedAvailability === false && now - lastCheckTime < 5000) {
    return false;
  }
  lastCheckTime = now;

  const bin = getPdftoppmBinary();
  const binDir = path.dirname(bin);

  return new Promise((resolve) => {
    const envPath = process.env.PATH
      ? `${binDir}${path.delimiter}${process.env.PATH}`
      : binDir;

    const child = spawn(bin, ['-v'], {
      env: { ...process.env, PATH: envPath },
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    child.on('error', (err) => {
      console.warn(`[rasterizer] pdftoppm check error at "${bin}":`, err.message);
      cachedAvailability = false;
      resolve(false);
    });

    child.on('close', (code) => {
      const ok = code === 0 || code === 1;
      cachedAvailability = ok;
      if (ok) {
        console.log(`[rasterizer] pdftoppm verified working at "${bin}"`);
      }
      resolve(ok);
    });

    setTimeout(() => {
      child.kill();
      cachedAvailability = false;
      resolve(false);
    }, 10_000).unref();
  });
}

/**
 * Convert PDF pages into ultra-fast, lightweight JPEG images (~50KB each).
 * Scales to 1200px width with quality 80 for razor-sharp text on mobile & desktop.
 */
export async function rasterizePdfToImages(
  pdfBuffer: Buffer,
  maxPages = 30,
): Promise<RasterizedPage[]> {
  const available = await isRasterizerAvailable();
  if (!available) {
    return [];
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'tailieu-pages-'));
  const inputPdfPath = path.join(workDir, 'input.pdf');
  const outputPrefix = path.join(workDir, 'page');

  try {
    await writeFile(inputPdfPath, pdfBuffer);

    const bin = getPdftoppmBinary();
    const binDir = path.dirname(bin);
    const envPath = process.env.PATH
      ? `${binDir}${path.delimiter}${process.env.PATH}`
      : binDir;

    await new Promise<void>((resolve, reject) => {
      const args = [
        '-jpeg',
        '-r', '144',
        '-scale-to-x', '1200',
        '-jpegopt', 'quality=80',
        '-f', '1',
        '-l', String(maxPages),
        inputPdfPath,
        outputPrefix,
      ];

      const child = spawn(bin, args, {
        cwd: workDir,
        env: { ...process.env, PATH: envPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr.on('data', (c: Buffer) => {
        stderr += c.toString();
      });

      child.on('error', (err) => reject(err));
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`pdftoppm exited with code ${code}: ${stderr}`));
        }
      });

      setTimeout(() => {
        child.kill();
        reject(new Error('pdftoppm rasterization timed out'));
      }, 30_000).unref();
    });

    const files = await readdir(workDir);
    const pageFiles = files
      .filter((f) => f.startsWith('page') && f.endsWith('.jpg'))
      .sort((a, b) => {
        const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
        const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
        return numA - numB;
      });

    const pages: RasterizedPage[] = [];
    for (let i = 0; i < pageFiles.length; i++) {
      const pageFile = pageFiles[i]!;
      const buf = await readFile(path.join(workDir, pageFile));
      pages.push({
        pageNum: i + 1,
        buffer: buf,
      });
    }

    return pages;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
