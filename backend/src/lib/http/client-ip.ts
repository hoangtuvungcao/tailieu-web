import type { FastifyRequest } from 'fastify';

/**
 * Who is actually calling.
 *
 * THE PROBLEM. The deployment has a fixed shape: browser → Cloudflare Pages →
 * a Pages Function → Cloudflare Tunnel → `localhost:4000`. The last hop is
 * loopback, so `request.ip` is `127.0.0.1` for *every user on the internet*,
 * and everything keyed on it collapses into one bucket:
 *
 *   - Rate limits. The global 300/min and the refresh route's 60 per 15
 *     minutes would be shared by the whole university, so a few dozen ordinary
 *     page loads would start refusing sign-in for everyone.
 *   - `sessions.ip_address` and the audit log. Every session and every
 *     moderation action would record the same address, which makes "revoke
 *     that device" and "where did this come from" unanswerable.
 *
 * WHAT THE PAGES FUNCTION ALREADY DOES. It reads `CF-Connecting-IP` — written
 * by Cloudflare's edge, which overwrites whatever the visitor sent — and
 * re-states it as `X-Forwarded-For`, having first *stripped* any
 * `X-Forwarded-For` the visitor supplied. So the leftmost entry is
 * trustworthy, which it is not in general: Cloudflare appends to an existing
 * `X-Forwarded-For`, so on a request that arrives with one, the leftmost value
 * is the client's own and reading it is spoofable.
 *
 * So the header is already correct. What was missing is that nothing read it:
 * `trustProxy` is off by default, so Fastify ignored it and kept reporting the
 * tunnel's loopback address.
 *
 * WHY NOT JUST SET `trustProxy: true`. Because Fastify would then trust
 * `X-Forwarded-For` from *any* peer. Anyone who could open a connection to
 * this process directly could send their own header and choose their
 * rate-limit bucket — the exact bypass this is meant to close. The address is
 * believed here only when the connection itself came from loopback, which is
 * the tunnel on this machine and nothing else.
 *
 * That check is also why the API binds to loopback (see `API_HOST`): if it
 * listened on every interface, a machine on the same LAN could reach it and
 * forge the header. The two settings only make sense together.
 */

/**
 * The leftmost address in `X-Forwarded-For`, when it can be believed.
 *
 * Returns the peer address otherwise, so the caller always has something to
 * key on even when the forwarded value is unusable.
 */
export function resolveClientIp(
  peer: string | undefined,
  forwarded: unknown,
): string | undefined {
  if (!isLoopback(peer)) return peer;
  if (typeof forwarded !== 'string') return peer;

  const candidate = forwarded.split(',')[0]?.trim();
  if (!candidate) return peer;

  // Never let a malformed value reach a rate-limit key or a database column.
  return isIpAddress(candidate) ? candidate : peer;
}

/**
 * Loopback in the forms Node reports it.
 *
 * `::ffff:127.0.0.1` is what an IPv4 loopback connection looks like on a
 * dual-stack socket, which is the common case on Windows.
 */
function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  if (address === '::1' || address === '::ffff:127.0.0.1') return true;
  // The whole 127/8 block is loopback, not just .0.1.
  return address.startsWith('127.');
}

/** Whether a string is a bare IPv4 or IPv6 address, and nothing else. */
function isIpAddress(value: string): boolean {
  // 45 is the longest an IPv6 address can be; anything longer is not one.
  if (value.length > 45) return false;
  if (!/^[0-9a-fA-F:.]+$/.test(value)) return false;

  // `::ffff:203.0.113.7` is how a v4 address arrives through a v6 socket, so
  // it is a real value to receive even though it carries both a colon and dots.
  const mapped = /^::ffff:(.+)$/i.exec(value);
  if (mapped?.[1]) return isIpv4(mapped[1]);

  // Anywhere else, a dot and a colon together is a port or a URL fragment —
  // `203.0.113.7:8080` — never an address. Without this split the IPv6 branch
  // accepts it, because that branch only checks for a colon.
  return value.includes('.') ? isIpv4(value) : isIpv6(value);
}

function isIpv4(value: string): boolean {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!parts) return false;
  // `String(Number(part)) === part` rejects leading zeros: `010` is octal to
  // some parsers and a different address to others.
  return parts.slice(1).every((part) => Number(part) <= 255 && String(Number(part)) === part);
}

function isIpv6(value: string): boolean {
  if (!value.includes(':') || value.includes(':::')) return false;
  // `::` may appear once, standing in for one or more zero groups.
  if (value.split('::').length > 2) return false;

  const groups = value.split(':').filter((group) => group !== '');
  return groups.length <= 8 && groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group));
}

/**
 * Rewrite `request.ip` for this request.
 *
 * `ip` is a getter on Fastify's request prototype, so it has to be shadowed on
 * the instance rather than assigned. `configurable: true` keeps it replaceable
 * so a second call is harmless rather than a TypeError.
 */
export function applyClientIp(request: FastifyRequest): void {
  const resolved = resolveClientIp(
    request.socket.remoteAddress,
    request.headers['x-forwarded-for'],
  );

  if (!resolved || resolved === request.ip) return;

  Object.defineProperty(request, 'ip', {
    value: resolved,
    configurable: true,
    enumerable: true,
  });
}
