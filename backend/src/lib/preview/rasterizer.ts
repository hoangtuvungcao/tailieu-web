import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface RasterizedPage {
  pageNum: number;
  buffer: Buffer;
}

/**
 * Locate pdftoppm executable across Windows and Linux.
 */
export function getPdftoppmBinary(): string {
  if (process.env.PDFTOPPM_PATH && existsSync(process.env.PDFTOPPM_PATH)) {
    return process.env.PDFTOPPM_PATH;
  }

  if (process.platform === 'win32') {
    const candidates = [
      'C:\\tailieu\\bin\\poppler\\Library\\bin\\pdftoppm.exe',
      'C:\\tailieu\\bin\\poppler\\bin\\pdftoppm.exe',
      'C:\\tailieu\\bin\\pdftoppm.exe',
      'C:\\Program Files\\poppler\\bin\\pdftoppm.exe',
      'C:\\Program Files\\poppler\\Library\\bin\\pdftoppm.exe',
      'C:\\tools\\poppler\\bin\\pdftoppm.exe',
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }

    // Check subfolders in C:\tailieu\bin\poppler (e.g. poppler-24.02.0)
    const basePopplerDir = 'C:\\tailieu\\bin\\poppler';
    if (existsSync(basePopplerDir)) {
      try {
        const subs = readdirSync(basePopplerDir);
        for (const sub of subs) {
          const subBin1 = path.join(basePopplerDir, sub, 'Library', 'bin', 'pdftoppm.exe');
          if (existsSync(subBin1)) return subBin1;
          const subBin2 = path.join(basePopplerDir, sub, 'bin', 'pdftoppm.exe');
          if (existsSync(subBin2)) return subBin2;
        }
      } catch {
        // ignore
      }
    }

    return 'pdftoppm.exe';
  }

  return 'pdftoppm';
}

let cachedAvailability: boolean | null = null;

/**
 * Check if pdftoppm is available on the system.
 */
export async function isRasterizerAvailable(): Promise<boolean> {
  if (cachedAvailability !== null) return cachedAvailability;

  return new Promise((resolve) => {
    const bin = getPdftoppmBinary();
    const child = spawn(bin, ['-v'], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', () => {
      cachedAvailability = false;
      resolve(false);
    });
    child.on('close', (code) => {
      cachedAvailability = code === 0 || code === 1; // pdftoppm -v exits with 0 or 1 depending on version
      resolve(cachedAvailability);
    });
    setTimeout(() => {
      child.kill();
      cachedAvailability = false;
      resolve(false);
    }, 3000).unref();
  });
}

/**
 * Convert PDF pages into ultra-fast, lightweight JPEG images (~50KB each).
 * Scales to 1200px width with quality 80 for razor-sharp text on mobile & desktop.
 */
export async function rasterizePdfToImages(
  pdfBuffer: Buffer,
  maxPages = 15,
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

    await new Promise<void>((resolve, reject) => {
      const bin = getPdftoppmBinary();
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

      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
