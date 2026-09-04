import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/** promisify() drops the options overload, so wrap it with the signature we need. */
function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

/**
 * scrypt from node:crypto. Deliberately not argon2 or bcrypt: both need a
 * native build, which is a deployment failure mode we do not need. scrypt at
 * these parameters is an accepted password hashing choice (OWASP: N >= 2^15,
 * r = 8, p = 1) and has zero install risk.
 *
 * Format: scrypt$N$r$p$<salt-b64>$<hash-b64>
 * The parameters travel with the hash, so they can be raised later without
 * invalidating existing passwords.
 */
const N = 32_768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
// scrypt needs roughly 128 * N * r bytes; the default 32MB cap is too low for N=2^15.
const MAX_MEMORY = 128 * N * R * 2;

export async function hashPassword(password: string): Promise<string> {
  assertReasonableLength(password);
  return derive(password);
}

/** Hashing with no policy attached; callers validate their own input first. */
async function derive(secret: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(secret.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEMORY,
  });
  return [
    'scrypt',
    N,
    R,
    P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (salt.length === 0 || expected.length === 0) return false;
  // Refuse absurd stored parameters rather than letting a poisoned hash
  // turn a login into a denial of service.
  if (n > 1 << 20 || r > 32 || p > 16) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: 128 * n * r * 2,
    });
  } catch {
    return false;
  }

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** True when the hash was made with weaker parameters than we now use. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < N || Number(parts[2]) < R;
}

/**
 * A PIN is a second factor for staff actions, not a password, so it has its own
 * policy: 4-12 digits. It is hashed with the identical scrypt parameters, which
 * matters because the keyspace is small and a fast hash would be trivially
 * brute-forced from a database leak.
 */
export async function hashPin(pin: string): Promise<string> {
  if (!/^\d{4,12}$/.test(pin)) {
    throw new Error('PIN must be 4 to 12 digits.');
  }
  return derive(pin);
}

export const verifyPin = verifyPassword;

function assertReasonableLength(password: string): void {
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  // Long inputs make scrypt slow; cap it so a huge body cannot burn CPU.
  if (Buffer.byteLength(password, 'utf8') > 1024) {
    throw new Error('Password is too long.');
  }
}
