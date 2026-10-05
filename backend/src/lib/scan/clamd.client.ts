import { createConnection, type Socket } from 'node:net';
import { Readable } from 'node:stream';

import { env } from '../../config/env.js';

/**
 * clamd client — the INSTREAM protocol over a TCP socket.
 *
 * No library. The protocol is a length-prefixed framing around raw bytes:
 *
 *   zINSTREAM\0
 *   <4-byte big-endian length><chunk bytes>     (repeated)
 *   <4-byte zero length>                        (end of stream)
 *
 * and the reply is a single line, `stream: OK` or `stream: <name> FOUND`.
 * That is small enough to implement directly, and doing so avoids a dependency
 * whose maintenance is tied to a daemon that is itself optional here.
 *
 * The stream is never buffered in full: chunks are forwarded as they arrive, so
 * scanning a 2GB file costs the same memory as scanning a 2KB one. ClamAV has
 * its own `StreamMaxLength` (usually 100MB by default) and will close the
 * connection past it — which is reported as a scan failure, not a pass.
 */

export type ScanVerdict =
  | { status: 'clean' }
  | { status: 'infected'; signature: string }
  | { status: 'error'; reason: string };

export interface ScanOptions {
  host: string;
  port: number;
  /** Abort and report an error past this, rather than hanging the worker. */
  timeoutMs?: number;
}

function optionsFromEnv(): ScanOptions {
  const [host, port] = env.CLAMAV_ADDRESS.split(':');
  return {
    host: host ?? '127.0.0.1',
    port: Number(port ?? 3310),
    timeoutMs: env.CLAMAV_TIMEOUT_MS,
  };
}

/**
 * Scan a stream.
 *
 * Resolves rather than throws for anything the daemon reports — including
 * "infected", which is a perfectly normal result. Only a transport failure
 * rejects, because that is the case a caller must not mistake for a clean file.
 */
export function scanStream(
  source: Readable,
  overrides: Partial<ScanOptions> = {},
): Promise<ScanVerdict> {
  const options = { ...optionsFromEnv(), ...overrides };

  return new Promise<ScanVerdict>((resolve, reject) => {
    const socket: Socket = createConnection({ host: options.host, port: options.port });
    let response = '';
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      source.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      // A hung scan is indistinguishable from a slow one, and a worker that
      // never returns looks healthy while nothing completes.
      finish(() =>
        resolve({
          status: 'error',
          reason: `Scan timed out after ${options.timeoutMs ?? 60_000}ms.`,
        }),
      );
    }, options.timeoutMs ?? 60_000);

    socket.on('error', (error) => {
      finish(() => reject(error));
    });

    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      // clamd terminates the reply with a NUL byte; anything longer is a
      // malformed reply and not worth waiting for.
      if (response.includes('\0') || response.length > 4096) {
        finish(() => resolve(parseVerdict(response)));
      }
    });

    socket.on('close', () => {
      // The daemon closed without a terminator — usually StreamMaxLength.
      finish(() =>
        resolve(
          response.trim()
            ? parseVerdict(response)
            : { status: 'error', reason: 'clamd closed the connection without a reply.' },
        ),
      );
    });

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');

      source.on('data', (chunk: Buffer) => {
        // Backpressure: if the socket buffer is full, pause until it drains.
        // Without this a large file is read entirely into memory by the socket
        // queue, which is exactly the buffering this design avoids.
        const ok = socket.write(encodeLength(chunk.length));
        if (!ok) source.pause();

        socket.write(chunk, () => {
          if (socket.writableLength < 1_048_576) source.resume();
        });
      });

      source.on('end', () => {
        // Zero-length chunk terminates the stream.
        socket.write(encodeLength(0));
      });

      source.on('error', (error) => {
        finish(() => reject(error));
      });
    });
  });
}

/** Four-byte big-endian length prefix. */
function encodeLength(length: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(length, 0);
  return buffer;
}

/**
 * Parse a clamd reply.
 *
 * The formats, all documented in the ClamAV manual:
 *   stream: OK
 *   stream: Eicar-Signature FOUND
 *   <anything> ERROR
 */
export function parseVerdict(raw: string): ScanVerdict {
  const line = raw.replace(/\0/g, '').trim();

  if (line.endsWith('OK')) return { status: 'clean' };

  if (line.endsWith('FOUND')) {
    // "stream: Win.Test.EICAR_HDB-1 FOUND" -> "Win.Test.EICAR_HDB-1"
    const match = /:\s*(.+?)\s+FOUND$/.exec(line);
    return { status: 'infected', signature: match?.[1] ?? 'unknown' };
  }

  return { status: 'error', reason: line || 'empty reply' };
}

/**
 * Check that clamd is reachable and its signature database is loaded.
 *
 * `PING` answers `PONG` once the daemon is serving. Called at worker startup so
 * a misconfiguration fails immediately rather than after every queued file has
 * been marked `failed`.
 */
export function pingClamd(overrides: Partial<ScanOptions> = {}): Promise<boolean> {
  const options = { ...optionsFromEnv(), ...overrides };

  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: options.host, port: options.port });
    let done = false;

    const settle = (value: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };

    const timer = setTimeout(() => settle(false), 5_000);

    socket.on('error', () => settle(false));
    socket.on('data', (chunk) => settle(chunk.toString('utf8').includes('PONG')));
    socket.on('connect', () => socket.write('zPING\0'));
  });
}
