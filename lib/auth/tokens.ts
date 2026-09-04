import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256 bits of entropy, URL-safe. Used for session and card tokens. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Tokens are stored hashed so a database leak does not hand out live sessions
 * or working cards. SHA-256 (not scrypt) is correct here: the input is already
 * high-entropy random, so there is nothing to brute force, and lookups must be
 * fast enough for the checkout path.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Non-reversible fingerprint for logging a credential we could not resolve. */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function appSecret(): Buffer {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'APP_SECRET must be set to at least 32 characters. Generate one with: openssl rand -base64 48',
    );
  }
  return Buffer.from(secret, 'utf8');
}

export function sign(payload: string, context: string): string {
  return createHmac('sha256', appSecret())
    .update(`${context}:${payload}`, 'utf8')
    .digest('base64url');
}

export function verifySignature(payload: string, context: string, signature: string): boolean {
  return constantTimeEquals(sign(payload, context), signature);
}
