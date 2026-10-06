import { createServer, type Server } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import { env } from '../../config/env.js';
import { parseVerdict, pingClamd, scanStream } from './clamd.client.js';

/**
 * clamd client tests.
 *
 * The INSTREAM protocol is hand-implemented, so the failure that matters is a
 * framing bug: get the length prefix or the terminator wrong and clamd either
 * hangs or answers about the wrong bytes. Either way the client sees a reply it
 * cannot interpret, and the danger is that it interprets it as clean. These
 * tests therefore drive a real TCP server that parses the framing back out,
 * rather than asserting against a mock that agrees with whatever we send.
 *
 * The parsing cases are exhaustive because `parseVerdict` is the last place a
 * "FOUND" reply can be mistaken for a pass.
 */

// --- A fake clamd ------------------------------------------------------------

interface FakeDaemon {
  port: number;
  /** Reassembled payload of the first stream, once terminated. */
  payload(): Buffer | null;
  close(): Promise<void>;
}

/** Daemons to shut down after each test. */
const open: FakeDaemon[] = [];

/**
 * Pull the INSTREAM payload out of the bytes received so far.
 *
 * Returns null until the zero-length terminator arrives, so "did the client
 * terminate the stream?" is answered by the same code that reads it.
 */
function extractPayload(buffer: Buffer): Buffer | null {
  const commandEnd = buffer.indexOf(0);
  if (commandEnd === -1) return null;

  let offset = commandEnd + 1;
  const parts: Buffer[] = [];

  while (offset + 4 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    offset += 4;
    if (length === 0) return Buffer.concat(parts);
    if (offset + length > buffer.length) return null;
    parts.push(buffer.subarray(offset, offset + length));
    offset += length;
  }
  return null;
}

/**
 * What the fake daemon does with a connection.
 *
 *   reply        write these bytes on every chunk (a ping-style answer)
 *   replyOnEnd   hold the reply until the client terminates the stream
 *   hangUp       destroy the socket — a daemon that dies mid-scan
 *   silent       accept and never answer, so the client must time out
 */
type Behaviour =
  | { kind: 'reply'; bytes: string }
  | { kind: 'replyOnEnd'; bytes: string }
  | { kind: 'hangUp' }
  | { kind: 'silent' };

async function fakeClamd(behaviour: Behaviour): Promise<FakeDaemon> {
  const received = { value: Buffer.alloc(0) };

  const server: Server = createServer((socket) => {
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      received.value = Buffer.concat([received.value, chunk]);

      if (behaviour.kind === 'hangUp') {
        socket.destroy();
        return;
      }
      if (behaviour.kind === 'reply') {
        socket.write(behaviour.bytes);
        return;
      }
      if (behaviour.kind === 'replyOnEnd' && extractPayload(received.value) !== null) {
        socket.write(behaviour.bytes);
      }
      // 'silent' deliberately does nothing.
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');

  const daemon: FakeDaemon = {
    port: address.port,
    payload: () => extractPayload(received.value),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };

  open.push(daemon);
  return daemon;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((daemon) => daemon.close()));
});

// --- Reply parsing -----------------------------------------------------------

describe('parseVerdict', () => {
  it('reads a clean reply', () => {
    expect(parseVerdict('stream: OK\0')).toEqual({ status: 'clean' });
  });

  it('reads an infected reply and keeps the signature', () => {
    expect(parseVerdict('stream: Win.Test.EICAR_HDB-1 FOUND\0')).toEqual({
      status: 'infected',
      signature: 'Win.Test.EICAR_HDB-1',
    });
  });

  it('strips the NUL terminator before matching', () => {
    // Without the strip, `endsWith('OK')` fails and a clean file would be
    // reported as an error — which reads as "scanner broken", not "file safe".
    expect(parseVerdict('stream: OK\0').status).toBe('clean');
  });

  it('handles a PATH-style infected reply', () => {
    expect(parseVerdict('/uploads/abc: Eicar-Signature FOUND\0')).toEqual({
      status: 'infected',
      signature: 'Eicar-Signature',
    });
  });

  it('never reports a FOUND reply as clean, whatever the signature', () => {
    const verdict = parseVerdict('stream: Some.New.Malware-99 FOUND\0');
    expect(verdict.status).toBe('infected');
  });

  it('treats a size-limit ERROR as an error rather than a pass', () => {
    const verdict = parseVerdict('INSTREAM size limit exceeded. ERROR\0');
    expect(verdict.status).toBe('error');
  });

  it('treats an empty reply as an error', () => {
    expect(parseVerdict('').status).toBe('error');
    expect(parseVerdict('\0').status).toBe('error');
  });
});

// --- Streaming ---------------------------------------------------------------

describe('scanStream', () => {
  it('sends the file and reports a clean verdict', async () => {
    const daemon = await fakeClamd({ kind: 'replyOnEnd', bytes: 'stream: OK\0' });
    const file = Buffer.from('a clean document');

    const verdict = await scanStream(Readable.from([file]), { host: '127.0.0.1', port: daemon.port });

    expect(verdict).toEqual({ status: 'clean' });
    // The daemon reassembled the stream from the framing we wrote, so this
    // fails if the length prefixes or the terminator are wrong.
    expect(daemon.payload()?.toString()).toBe('a clean document');
  });

  it('reports an infected verdict with the signature', async () => {
    const daemon = await fakeClamd({
      kind: 'replyOnEnd',
      bytes: 'stream: Win.Test.EICAR_HDB-1 FOUND\0',
    });

    const verdict = await scanStream(Readable.from([Buffer.from('X5O!P%@AP[4\\PZX54')]), {
      host: '127.0.0.1',
      port: daemon.port,
    });

    expect(verdict).toEqual({ status: 'infected', signature: 'Win.Test.EICAR_HDB-1' });
  });

  it('reassembles a multi-chunk stream byte for byte', async () => {
    const daemon = await fakeClamd({ kind: 'replyOnEnd', bytes: 'stream: OK\0' });
    const chunks = [Buffer.from('first '), Buffer.from('second '), Buffer.from('third')];

    await scanStream(Readable.from(chunks), { host: '127.0.0.1', port: daemon.port });

    // Each chunk gets its own length prefix; a client that wrote one prefix for
    // the whole file would deliver the right byte count but the wrong framing.
    expect(daemon.payload()?.toString()).toBe('first second third');
  });

  it('gives up rather than hanging when the daemon never answers', async () => {
    const daemon = await fakeClamd({ kind: 'silent' });

    const verdict = await scanStream(Readable.from([Buffer.from('data')]), {
      host: '127.0.0.1',
      port: daemon.port,
      timeoutMs: 300,
    });

    // An error, never a pass: "we could not check it" must not read as safe.
    expect(verdict.status).toBe('error');
  });

  it('treats a daemon that drops the connection as an error', async () => {
    const daemon = await fakeClamd({ kind: 'hangUp' });

    const verdict = await scanStream(Readable.from([Buffer.from('data')]), {
      host: '127.0.0.1',
      port: daemon.port,
      timeoutMs: 1_000,
    });

    expect(verdict.status).toBe('error');
  });

  it('rejects when the daemon is not listening', async () => {
    // Port 1 is reserved and never has a listener in a test container.
    await expect(
      scanStream(Readable.from([Buffer.from('data')]), {
        host: '127.0.0.1',
        port: 1,
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow();
  });
});

// --- Ping --------------------------------------------------------------------

describe('pingClamd', () => {
  it('is true when the daemon answers PONG', async () => {
    const daemon = await fakeClamd({ kind: 'reply', bytes: 'PONG\0' });
    expect(await pingClamd({ host: '127.0.0.1', port: daemon.port })).toBe(true);
  });

  it('is false when nothing is listening', async () => {
    expect(await pingClamd({ host: '127.0.0.1', port: 1 })).toBe(false);
  });
});

// --- The real daemon ---------------------------------------------------------

/**
 * EICAR against the real ClamAV, when one is reachable.
 *
 * The unit tests above prove the client speaks the protocol; only this proves
 * the daemon on the other end actually detects malware. It is skipped rather
 * than failed when clamd is absent, because the scan profile is off by default
 * and a suite that cannot pass without a 1GB signature database is a suite
 * people learn to ignore.
 */
const [clamHost, clamPort] = env.CLAMAV_ADDRESS.split(':');

describe('EICAR against a live clamd', () => {
  it('detects the standard test file', async () => {
    const reachable = await pingClamd({ host: clamHost!, port: Number(clamPort ?? 3310) });
    if (!reachable) {
      console.warn('[scan.test] clamd not reachable; skipping live EICAR check');
      return;
    }

    // The 68-byte EICAR string. Harmless — it is not a virus, it is the string
    // every scanner is required to flag, which is exactly what makes it a
    // usable proof that detection works end to end.
    const eicar =
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

    const verdict = await scanStream(Readable.from([Buffer.from(eicar)]), {
      host: clamHost!,
      port: Number(clamPort ?? 3310),
    });

    expect(verdict.status).toBe('infected');

    // And the same daemon still passes ordinary content, so the detection above
    // is the signature matching rather than the scanner rejecting everything.
    const clean = await scanStream(Readable.from([Buffer.from('an ordinary PDF-ish document')]), {
      host: clamHost!,
      port: Number(clamPort ?? 3310),
    });
    expect(clean.status).toBe('clean');
  });
});
