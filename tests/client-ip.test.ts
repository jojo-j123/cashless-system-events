import { afterEach, describe, expect, it } from 'vitest';
import { clientIp } from '../lib/api/client-ip';

/**
 * The client IP is a rate-limit key. If an attacker can choose it, they can mint
 * unlimited fresh buckets and the login limiter stops existing — so these tests
 * are about what we refuse to believe, not just what we parse.
 */

const originalMode = process.env.TRUSTED_PROXY;

afterEach(() => {
  if (originalMode === undefined) delete process.env.TRUSTED_PROXY;
  else process.env.TRUSTED_PROXY = originalMode;
});

/** Minimal stand-in for both `next/headers` and `request.headers`. */
function headers(bag: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(bag).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower.get(name.toLowerCase()) ?? null };
}

describe('cloudflare mode', () => {
  it('uses CF-Connecting-IP', () => {
    process.env.TRUSTED_PROXY = 'cloudflare';
    expect(clientIp(headers({ 'cf-connecting-ip': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('ignores X-Forwarded-For entirely', () => {
    process.env.TRUSTED_PROXY = 'cloudflare';
    // Cloudflare overwrites CF-Connecting-IP, so it is the only header a client
    // cannot choose. A spoofed XFF must not win, and must not even be a fallback.
    const ip = clientIp(
      headers({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }),
    );
    expect(ip).toBe('203.0.113.7');
  });

  it('returns null when the request did not come through Cloudflare', () => {
    process.env.TRUSTED_PROXY = 'cloudflare';
    expect(clientIp(headers({ 'x-forwarded-for': '198.51.100.1' }))).toBeNull();
  });
});

describe('forwarded mode', () => {
  it('takes the first X-Forwarded-For entry', () => {
    process.env.TRUSTED_PROXY = 'forwarded';
    expect(clientIp(headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' }))).toBe(
      '203.0.113.7',
    );
  });

  it('falls back to X-Real-IP', () => {
    process.env.TRUSTED_PROXY = 'forwarded';
    expect(clientIp(headers({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('is the default when TRUSTED_PROXY is unset', () => {
    delete process.env.TRUSTED_PROXY;
    expect(clientIp(headers({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('falls back to forwarded on an unrecognised TRUSTED_PROXY value', () => {
    process.env.TRUSTED_PROXY = 'nonsense';
    expect(clientIp(headers({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
  });
});

describe('none mode', () => {
  it('trusts no forwarded header', () => {
    process.env.TRUSTED_PROXY = 'none';
    const ip = clientIp(
      headers({ 'x-forwarded-for': '203.0.113.7', 'cf-connecting-ip': '203.0.113.8' }),
    );
    expect(ip).toBeNull();
  });
});

describe('rejecting hostile values', () => {
  it('rejects a value that is not shaped like an address', () => {
    process.env.TRUSTED_PROXY = 'forwarded';
    expect(clientIp(headers({ 'x-forwarded-for': 'robert; DROP TABLE accounts' }))).toBeNull();
  });

  it('rejects an over-long value rather than writing it to a rate-limit row', () => {
    process.env.TRUSTED_PROXY = 'forwarded';
    expect(clientIp(headers({ 'x-forwarded-for': '1'.repeat(500) }))).toBeNull();
  });

  it('rejects an empty or whitespace-only header', () => {
    process.env.TRUSTED_PROXY = 'forwarded';
    expect(clientIp(headers({ 'x-forwarded-for': '   ' }))).toBeNull();
  });

  it('accepts IPv6', () => {
    process.env.TRUSTED_PROXY = 'forwarded';
    expect(clientIp(headers({ 'x-forwarded-for': '2001:db8::1' }))).toBe('2001:db8::1');
  });

  it('returns null when no header is present at all', () => {
    process.env.TRUSTED_PROXY = 'forwarded';
    expect(clientIp(headers({}))).toBeNull();
  });
});
