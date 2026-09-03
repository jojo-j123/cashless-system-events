/**
 * Client IP resolution, proxy-aware.
 *
 * Rate limits and audit records key off the client IP, so how we read it is a
 * security decision, not a formatting one. `X-Forwarded-For` is a request
 * header: anything that can reach the origin directly can set it to whatever
 * it likes. Trusting it unconditionally means an attacker rotating fake values
 * gets an unlimited number of fresh rate-limit buckets, and the login limiter
 * stops existing.
 *
 * So we only trust the header the deployment actually guarantees, named by
 * TRUSTED_PROXY:
 *
 *   cloudflare  Trust CF-Connecting-IP only. Cloudflare always overwrites this
 *               with the real client IP, so it cannot be forged *through* the
 *               proxy. Requires the origin to reject traffic that did not come
 *               from Cloudflare — see docs/deployment.md. Without that lock,
 *               no header choice is safe.
 *   forwarded   Trust the first X-Forwarded-For entry, then X-Real-IP. Correct
 *               for a single trusted reverse proxy (Railway, Fly, Render, nginx)
 *               with no public path around it.
 *   none        Trust nothing. Use when the app is directly exposed; there is
 *               no portable way to read the socket address from a Next route
 *               handler, so callers get null and must degrade explicitly.
 *
 * Default is `forwarded`, which matches every managed Node host.
 */

/** Both `next/headers` and `request.headers` satisfy this. */
interface HeaderReader {
  get(name: string): string | null;
}

type TrustedProxy = 'cloudflare' | 'forwarded' | 'none';

const VALID_MODES = new Set<TrustedProxy>(['cloudflare', 'forwarded', 'none']);

/**
 * Long enough for IPv6 with a zone id, short enough that a hostile value cannot
 * be used to write large rows into the rate-limit table.
 */
const MAX_IP_LENGTH = 64;
/** Hex, dots, colons, and the IPv6 zone separator. Deliberately no wildcards. */
const IP_SHAPED = /^[0-9a-fA-F.:%]+$/;

let warnedAboutMode = false;

function mode(): TrustedProxy {
  const raw = (process.env.TRUSTED_PROXY ?? 'forwarded').trim().toLowerCase();
  if (VALID_MODES.has(raw as TrustedProxy)) return raw as TrustedProxy;

  if (!warnedAboutMode) {
    warnedAboutMode = true;
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'TRUSTED_PROXY is not one of cloudflare|forwarded|none; falling back to forwarded',
        value: raw,
      }),
    );
  }
  return 'forwarded';
}

/**
 * Reject values that are not plausibly an address before they become a
 * rate-limit key or an audit row. This does not make a forged header safe — only
 * a locked-down origin does that — it just bounds the damage.
 */
function sanitise(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_IP_LENGTH) return null;
  if (!IP_SHAPED.test(trimmed)) return null;
  return trimmed;
}

/**
 * The client IP, or null when the deployment cannot vouch for one.
 *
 * Null is meaningful: callers must decide what to do without an IP rather than
 * bucketing every anonymous request together. See the login route for why a
 * shared "unknown" bucket is worse than no IP limit at all.
 */
export function clientIp(headers: HeaderReader): string | null {
  switch (mode()) {
    case 'cloudflare':
      return sanitise(headers.get('cf-connecting-ip'));
    case 'forwarded':
      return (
        sanitise(headers.get('x-forwarded-for')?.split(',')[0]) ??
        sanitise(headers.get('x-real-ip'))
      );
    case 'none':
      return null;
  }
}
