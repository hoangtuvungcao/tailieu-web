import { describe, expect, it } from 'vitest';

import { resolveClientIp } from './client-ip.js';

/**
 * The client address is a security boundary, not a formatting detail.
 *
 * Everything here is about one question: when may a header be believed over
 * the address the connection actually came from? Believing it when we should
 * not lets a caller choose their own rate-limit bucket — or, since the value
 * is also written to `sessions.ip_address` and the audit log, lets them write
 * someone else's address into the record.
 */
describe('resolveClientIp', () => {
  describe('from the tunnel (loopback peer)', () => {
    it('believes the forwarded address', () => {
      expect(resolveClientIp('127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
    });

    it('believes it over IPv6 loopback, and over the dual-stack form', () => {
      // `::ffff:127.0.0.1` is what a Windows dual-stack socket reports.
      expect(resolveClientIp('::1', '203.0.113.7')).toBe('203.0.113.7');
      expect(resolveClientIp('::ffff:127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
      expect(resolveClientIp('127.0.0.5', '203.0.113.7')).toBe('203.0.113.7');
    });

    it('takes the first entry of a chain, which is the one our function wrote', () => {
      // Cloudflare appends to an existing header, so a chain can arrive with
      // the connector's own address after ours.
      expect(resolveClientIp('127.0.0.1', '203.0.113.7, 198.51.100.9')).toBe('203.0.113.7');
    });

    it('accepts an IPv6 client', () => {
      expect(resolveClientIp('127.0.0.1', '2001:db8::1')).toBe('2001:db8::1');
    });

    it('accepts the v4-mapped v6 form, which a v6 socket really produces', () => {
      expect(resolveClientIp('127.0.0.1', '::ffff:203.0.113.7')).toBe('::ffff:203.0.113.7');
    });
  });

  describe('from anywhere else', () => {
    it('ignores the header entirely', () => {
      // THE assertion. Reaching this process over the network must not let a
      // caller name their own address.
      expect(resolveClientIp('192.0.2.50', '203.0.113.7')).toBe('192.0.2.50');
      expect(resolveClientIp('10.0.0.4', '127.0.0.1')).toBe('10.0.0.4');
    });

    it('ignores a header that claims to come from loopback', () => {
      // The mirror of the check above: a public peer pretending to be the
      // tunnel gets nothing.
      expect(resolveClientIp('198.51.100.3', '127.0.0.1')).toBe('198.51.100.3');
    });
  });

  describe('unusable forwarded values', () => {
    it('falls back to the peer when the header is absent', () => {
      expect(resolveClientIp('127.0.0.1', undefined)).toBe('127.0.0.1');
    });

    it('falls back when the header is empty or blank', () => {
      expect(resolveClientIp('127.0.0.1', '')).toBe('127.0.0.1');
      expect(resolveClientIp('127.0.0.1', '   ')).toBe('127.0.0.1');
      expect(resolveClientIp('127.0.0.1', ' , 198.51.100.9')).toBe('127.0.0.1');
    });

    it('rejects anything that is not a bare address', () => {
      // A malformed value would become a rate-limit key and a database column,
      // so it must never survive.
      for (const value of [
        'not-an-ip',
        '203.0.113.7:8080',
        '[2001:db8::1]',
        '999.1.1.1',
        '203.0.113.7/24',
        '203.0.113.7 evil',
        '0x7f.0.0.1',
        '203.0.113.07',
        'a'.repeat(60),
      ]) {
        expect(resolveClientIp('127.0.0.1', value), value).toBe('127.0.0.1');
      }
    });

    it('handles a repeated header, which Fastify gives as an array', () => {
      // Two headers with the same name are never something we send, so the
      // safe reading is "unusable".
      expect(resolveClientIp('127.0.0.1', ['203.0.113.7', '198.51.100.9'])).toBe('127.0.0.1');
    });
  });

  it('always returns something, so a caller never keys on undefined', () => {
    expect(resolveClientIp(undefined, undefined)).toBeUndefined();
    expect(resolveClientIp('127.0.0.1', undefined)).toBe('127.0.0.1');
  });
});
