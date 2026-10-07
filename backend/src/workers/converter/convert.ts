import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { env } from '../../config/env.js';

/**
 * LibreOffice conversion.
 *
 * The two things that make this work reliably, and both are non-obvious:
 *
 * 1. AN ISOLATED USER PROFILE PER CONVERSION. LibreOffice keeps a profile
 *    directory and takes a lock on it. Two concurrent invocations sharing the
 *    default profile do not queue politely — the second exits immediately with
 *    a generic failure, or worse, silently produces a truncated file. Passing
 *    `-env:UserInstallation` with a unique directory per job is what makes
 *    concurrency safe. This is the single most common cause of "LibreOffice
 *    works on my machine" in a container.
 *
 * 2. A HARD TIMEOUT. soffice occasionally hangs on a malformed document and
 *    will sit there indefinitely. A worker that never returns is
 *    indistinguishable from one that is merely slow, so the queue appears
 *    healthy while nothing completes. The process is killed and the job fails
 *    so the file stops being `processing` forever.
 */

export interface ConversionResult {
  /** Converted PDF bytes. */
  buffer: Buffer;
  /** Wall-clock duration, logged so slow conversions are visible. */
  durationMs: number;
}

export class ConversionError extends Error {
  readonly code = 'CONVERSION_FAILED';
  constructor(
    message: string,
    readonly stderr?: string,
  ) {
    super(message);
    this.name = 'ConversionError';
  }
}

/**
 * Kill a process and everything it spawned.
 *
 * Two platform problems in one:
 *
 *   1. `SIGKILL` does not exist on Windows. `child.kill()` there terminates
 *      the process abruptly but cannot deliver a Unix signal, so passing
 *      'SIGKILL' is misleading about what happens.
 *   2. soffice is not a single process. It launches a child tree, and killing
 *      only the parent on Windows leaves the children running — which is
 *      exactly the hang this timeout exists to break, now with extra processes
 *      holding the profile lock.
 *
 * `taskkill /T` kills the tree. On Unix, a negative pid signals the whole
 * process group, which requires the child to have been spawned detached — so
 * the direct kill is used there and the group is not relied upon.
 */
function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    // Fire and forget: this runs from a timeout handler where awaiting would
    // delay the rejection the caller is waiting for.
    spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore' }).on(
      'error',
      () => undefined,
    );
    return;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone — killing a reaped process throws ESRCH.
  }
}

/**
 * The LibreOffice executable.
 *
 * Named `soffice.exe` on Windows, and — more importantly — Windows does not
 * put it on PATH. The installer places it under Program Files, so a bare
 * `spawn('soffice')` fails with ENOENT on a machine where LibreOffice is
 * plainly installed and working from the Start menu.
 *
 * SOFFICE_PATH overrides both, for a non-standard install location.
 */
function sofficeBinary(): string {
  if (process.env.SOFFICE_PATH && existsSync(process.env.SOFFICE_PATH)) {
    return process.env.SOFFICE_PATH;
  }
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files\\LibreOffice 24\\program\\soffice.exe',
      'C:\\Program Files\\LibreOffice 7\\program\\soffice.exe',
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return 'soffice.exe';
  }
  return 'soffice';
}

/**
 * Convert a document to PDF.
 *
 * Writes the source to a temp file because soffice takes a path, not a stream —
 * it is a separate process and expects to open the file itself. The whole job
 * is confined to a temp directory that is always removed.
 */
export async function convertToPdf(
  source: Buffer,
  originalName: string,
): Promise<ConversionResult> {
  // One directory for the profile and the output, unique per job, so two
  // concurrent conversions cannot see each other's state.
  const workDir = await mkdtemp(path.join(tmpdir(), 'tailieu-convert-'));
  const profileDir = path.join(workDir, 'profile');
  const outputDir = path.join(workDir, 'out');

  const started = Date.now();

  try {
    // The extension matters: LibreOffice picks its import filter from it, and a
    // .docx renamed to .bin is refused as an unrecognised format.
    const safeName = sanitiseExtension(originalName);
    const inputPath = path.join(workDir, safeName);

    await writeFile(inputPath, source);
    await mkdirp(outputDir);
    await mkdirp(profileDir);

    const { stdout, stderr, code } = await runSoffice({
      inputPath,
      outputDir,
      profileDir,
      timeoutMs: env.CONVERT_TIMEOUT_MS,
    });

    if (code !== 0) {
      throw new ConversionError(
        `LibreOffice exited with code ${code}.`,
        stderr || stdout,
      );
    }

    // soffice names the output after the input's basename with a .pdf
    // extension. Deriving it rather than globbing avoids picking up a stray
    // file if the document happens to embed one.
    const baseName = path.parse(safeName).name;
    const pdfPath = path.join(outputDir, `${baseName}.pdf`);

    let pdfStat;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        pdfStat = await stat(pdfPath);
        if (pdfStat && pdfStat.size > 0) break;
      } catch {
        // Wait 150ms for Windows filesystem flush
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    if (!pdfStat) {
      // soffice returned success but wrote nothing. This happens with
      // password-protected files and some malformed documents.
      throw new ConversionError(
        'LibreOffice reported success but produced no PDF. The file may be password-protected or corrupt.',
        stderr,
      );
    }

    if (pdfStat.size === 0) {
      throw new ConversionError('LibreOffice produced an empty PDF.', stderr);
    }

    const buffer = await readFile(pdfPath);

    return { buffer, durationMs: Date.now() - started };
  } finally {
    // Always cleaned up, including on the error path — a worker that leaks a
    // temp directory per failed job fills the disk within days on a laptop.
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface SofficeRun {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runSoffice(options: {
  inputPath: string;
  outputDir: string;
  profileDir: string;
  timeoutMs: number;
}): Promise<SofficeRun> {
  return new Promise((resolve, reject) => {
    const args = [
      // Never a GUI; there is no display in the container.
      '--headless',
      // Do not restore the previous session or show recovery dialogs — either
      // would block waiting for input that will never arrive.
      '--norestore',
      '--nolockcheck',
      '--nodefault',
      '--nofirststartwizard',
      // The isolated profile. LibreOffice requires a file:// URL here, and
      // building one by string interpolation is wrong on Windows —
      // `file://C:\Users\...` is not a valid URL (it needs three slashes and
      // forward slashes). pathToFileURL produces the correct form on both
      // platforms, which is the whole reason it exists.
      `-env:UserInstallation=${pathToFileURL(options.profileDir).href}`,
      '--convert-to',
      'pdf',
      '--outdir',
      options.outputDir,
      options.inputPath,
    ];

    const child = spawn(sofficeBinary(), args, {
      // stdin closed, or soffice may wait on it in some failure modes.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // LibreOffice writes a profile directory on first run. HOME is the
        // Unix variable and USERPROFILE the Windows one — setting only HOME
        // means Windows ignores the override and writes to the real user
        // profile, which reintroduces the shared-profile locking this whole
        // arrangement exists to avoid.
        HOME: options.profileDir,
        USERPROFILE: options.profileDir,
      },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child.pid);
      reject(
        new ConversionError(
          `Conversion timed out after ${options.timeoutMs}ms. The document may be malformed or excessively large.`,
          stderr,
        ),
      );
    }, options.timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new ConversionError(
          `Could not start LibreOffice: ${error.message}. Is it installed in this image?`,
        ),
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Give the temp file a plausible extension.
 *
 * soffice selects its import filter by extension, so the original name's
 * extension is preserved — but a whitelist is applied rather than trusting it,
 * because a name like `../../etc/passwd.docx` must not influence the path.
 */
function sanitiseExtension(originalName: string): string {
  const allowed = new Set([
    'doc', 'docx', 'odt', 'rtf', 'txt',
    'xls', 'xlsx', 'ods', 'csv',
    'ppt', 'pptx', 'odp',
  ]);

  const ext = (originalName.split('.').pop() ?? '').toLowerCase();
  const safeExt = allowed.has(ext) ? ext : 'bin';
  // A fixed basename, not the user's. The name is irrelevant to conversion and
  // using it would carry a path-traversal risk for no benefit.
  return `source.${safeExt}`;
}

async function mkdirp(dir: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
}

/** Confirms the soffice binary is reachable, for the health endpoint. */
export async function checkConverterAvailable(): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn(sofficeBinary(), ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on('error', () => resolve({ ok: false, detail: 'soffice not found on PATH' }));
    child.on('close', (code) =>
      resolve({ ok: code === 0, detail: out.trim() || `exit ${code}` }),
    );
    setTimeout(() => {
      killProcessTree(child.pid);
      resolve({ ok: false, detail: 'soffice --version timed out' });
    }, 10_000).unref();
  });
}
