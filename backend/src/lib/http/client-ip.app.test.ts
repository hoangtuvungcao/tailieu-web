import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { assertTestDatabase } from '../../test/helpers.js';

/**
 * The client address, as the running application resolves it.
 *
 * `resolveClientIp` is unit-tested next to the code. What this file checks is
 * the *wiring*, which unit tests cannot see: that the hook is registered at
 * all, and that it is registered early enough to run before the rate limiters
 * read `request.ip`.
 *
 * Both failures are silent. If the hook is missing, or ordered after the
 * limiter, every request is keyed on the tunnel's loopback address and the
 * limits become one bucket shared by the whole internet — with no error, no
 * log line, and no failing request until enough people use the site at once.
 */

assertTestDatabase();

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();

  // A probe route rather than an existing endpoint. The address a route
  // records is an implementation detail of that route, so asserting through
  // one would test the route as much as the hook. Registered after `buildApp`
  // returns, which still receives the global `onRequest` hook because Fastify
  // applies hooks that exist at the moment a route is added.
  app.get('/__client-ip', async (request) => ({ ip: request.ip }));
});

afterAll(async () => {
  await app.close();
});

async function ipFor(options: {
  remoteAddress?: string;
  forwarded?: string;
}): Promise<string | undefined> {
  const response = await app.inject({
    method: 'GET',
    url: '/__client-ip',
    remoteAddress: options.remoteAddress,
    headers: options.forwarded ? { 'x-forwarded-for': options.forwarded } : {},
  });

  // The envelope plugin wraps every response, so the payload is under `data`.
  return (response.json() as { data?: { ip?: string } }).data?.ip;
}

describe('client address resolution', () => {
  it('believes the forwarded address when the connection is the tunnel', async () => {
    // What a real visitor looks like: the tunnel connects from loopback and
    // our Pages Function has already written the visitor's address.
    await expect(
      ipFor({ remoteAddress: '127.0.0.1', forwarded: '203.0.113.7' }),
    ).resolves.toBe('203.0.113.7');
  });

  it('ignores the header when the connection is not the tunnel', async () => {
    // THE security assertion. A direct connection must not be able to name
    // its own address — that would let it choose its own rate-limit bucket and
    // write someone else's address into the session and audit records.
    await expect(
      ipFor({ remoteAddress: '192.0.2.50', forwarded: '203.0.113.7' }),
    ).resolves.toBe('192.0.2.50');
  });

  it('ignores a forged header claiming to be loopback', async () => {
    await expect(
      ipFor({ remoteAddress: '198.51.100.3', forwarded: '127.0.0.1' }),
    ).resolves.toBe('198.51.100.3');
  });

  it('falls back to the peer when nothing was forwarded', async () => {
    // Local development and health checks take this path, so it must not
    // leave the address undefined — every rate-limit key interpolates it.
    await expect(ipFor({ remoteAddress: '127.0.0.1' })).resolves.toBe('127.0.0.1');
  });

  it('rejects a malformed forwarded value rather than keying on it', async () => {
    await expect(
      ipFor({ remoteAddress: '127.0.0.1', forwarded: '203.0.113.7:8080' }),
    ).resolves.toBe('127.0.0.1');
  });

  it('separates two visitors arriving through the same tunnel', async () => {
    // The property the whole module exists for. Before it, these were one
    // client and shared a single rate-limit bucket.
    const first = await ipFor({ remoteAddress: '127.0.0.1', forwarded: '203.0.113.7' });
    const second = await ipFor({ remoteAddress: '127.0.0.1', forwarded: '198.51.100.9' });

    expect(first).not.toBe(second);
  });
});
