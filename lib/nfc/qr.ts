import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * QR fallback credential.
 *
 * The payload carries only a public participant reference and an expiry — no
 * name, no id, no balance. It is signed with the app secret mixed with a
 * per-user secret, so a leaked QR from one user says nothing about another,
 * and rotating that user's secret invalidates every code they ever showed.
 *
 * Short-lived by design: a screenshot shared in a group chat is worthless
 * within a couple of minutes.
 */
const VERSION = 'CQ1';

function computeSignature(participantRef: string, expiresAt: number, userSecret: string): string {
  const appSecret = process.env.APP_SECRET;
  if (!appSecret || appSecret.length < 32) {
    throw new Error('APP_SECRET must be set to at least 32 characters.');
  }
  return createHmac('sha256', appSecret)
    .update(`${VERSION}.${participantRef}.${expiresAt}.${userSecret}`, 'utf8')
    .digest('base64url');
}

export function issueQrToken(
  participantRef: string,
  userSecret: string,
  ttlSeconds: number,
): { token: string; expiresAt: Date } {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = computeSignature(participantRef, expiresAt, userSecret);
  return {
    token: `${VERSION}.${participantRef}.${expiresAt}.${signature}`,
    expiresAt: new Date(expiresAt * 1000),
  };
}

export interface ParsedQrToken {
  participantRef: string;
  expiresAt: number;
  signature: string;
}

/** Structural parse only. The signature cannot be checked until the user's
 *  secret has been loaded, which needs the participant reference from here. */
export function parseQrToken(token: string): ParsedQrToken | null {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [version, participantRef, expiryText, signature] = parts;
  if (version !== VERSION || !participantRef || !expiryText || !signature) return null;

  const expiresAt = Number(expiryText);
  if (!Number.isInteger(expiresAt)) return null;

  return { participantRef, expiresAt, signature };
}

export function verifyQrToken(parsed: ParsedQrToken, userSecret: string): boolean {
  if (parsed.expiresAt * 1000 <= Date.now()) return false;
  const expected = Buffer.from(
    computeSignature(parsed.participantRef, parsed.expiresAt, userSecret),
    'utf8',
  );
  const actual = Buffer.from(parsed.signature, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
