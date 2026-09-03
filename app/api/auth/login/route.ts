import { cookies } from 'next/headers';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { route } from '@/lib/api/handler';
import { clientIp } from '@/lib/api/client-ip';
import { ok } from '@/lib/api/responses';
import { loginSchema } from '@/lib/api/schemas';
import { verifyPassword, needsRehash, hashPassword } from '@/lib/auth/password';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  createSession,
} from '@/lib/auth/session';
import { loadActor } from '@/lib/authz/actor';
import { recordAudit } from '@/lib/audit';
import { enforceRateLimit, RATE_LIMITS } from '@/lib/core/rate-limit';
import { UnauthenticatedError } from '@/lib/errors';
import { getEventSettings } from '@/lib/settings/service';
import { events } from '@/lib/db/schema';

const LOCKOUT_THRESHOLD = 8;
const LOCKOUT_MINUTES = 15;

export const POST = route({ public: true, body: loginSchema }, async ({ request, body }) => {
  const db = getDb();
  const ipAddress = clientIp(request.headers);

  // Limit by IP before touching the database, so credential stuffing costs the
  // attacker rather than us.
  //
  // When the deployment cannot vouch for an IP (see lib/api/client-ip.ts) we
  // skip this limit rather than bucketing every caller under a shared "unknown"
  // key. A shared bucket would let one attacker exhaust it and lock every
  // cashier out mid-event — trading a rate limit for a denial of service. The
  // per-email limit and the account lockout below still apply either way.
  if (ipAddress) {
    await enforceRateLimit(db, RATE_LIMITS.login, ipAddress, 'Too many sign-in attempts.');
  }
  await enforceRateLimit(db, RATE_LIMITS.login, `email:${body.email}`, 'Too many sign-in attempts.');

  const [user] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      passwordHash: users.passwordHash,
      status: users.status,
      lockedUntil: users.lockedUntil,
      failedLoginCount: users.failedLoginCount,
    })
    .from(users)
    .where(and(sql`lower(${users.email}) = ${body.email}`, isNull(users.deletedAt)))
    .limit(1);

  // One message for every failure mode: a distinct "no such account" response
  // is a free user-enumeration oracle.
  const invalid = new UnauthenticatedError('Email or password is incorrect.');

  if (!user || !user.passwordHash) {
    // Spend comparable time so a missing account is not detectably faster.
    await verifyPassword(body.password, 'scrypt$32768$8$1$c2FsdHNhbHQ=$aGFzaGhhc2g=');
    throw invalid;
  }
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    throw new UnauthenticatedError(
      'This account is temporarily locked after too many failed attempts.',
    );
  }
  if (user.status !== 'ACTIVE') {
    throw new UnauthenticatedError('This account is not active. Please contact event staff.');
  }

  if (!(await verifyPassword(body.password, user.passwordHash))) {
    const failures = user.failedLoginCount + 1;
    await db
      .update(users)
      .set({
        failedLoginCount: failures,
        lockedUntil:
          failures >= LOCKOUT_THRESHOLD
            ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
            : null,
      })
      .where(eq(users.id, user.id));
    throw invalid;
  }

  if (needsRehash(user.passwordHash)) {
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(body.password) })
      .where(eq(users.id, user.id));
  }

  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(users.id, user.id));

  const [activeEvent] = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.status, 'ACTIVE'))
    .limit(1);
  const settings = activeEvent
    ? await getEventSettings(db, activeEvent.id)
    : { sessionTimeoutMinutes: 720 };

  const session = await createSession(db, {
    userId: user.id,
    ttlMinutes: settings.sessionTimeoutMinutes,
    userAgent: request.headers.get('user-agent'),
    ipAddress,
  });

  const cookieBag = await cookies();
  const secure = process.env.NODE_ENV === 'production';
  cookieBag.set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    expires: session.expiresAt,
  });
  // Readable by our own JavaScript so it can be echoed in a header; that is
  // the point of the double-submit pattern.
  cookieBag.set(CSRF_COOKIE, session.csrfToken, {
    httpOnly: false,
    sameSite: 'lax',
    secure,
    path: '/',
    expires: session.expiresAt,
  });

  const actor = await loadActor(db, user.id, activeEvent?.id ?? null);

  await recordAudit(db, {
    eventId: activeEvent?.id ?? null,
    actorUserId: user.id,
    action: 'auth.login',
    targetType: 'user',
    targetId: user.id,
    ipAddress,
    userAgent: request.headers.get('user-agent'),
  });

  return ok({
    user: {
      id: user.id,
      displayName: user.displayName,
      roles: actor?.roleKeys ?? [],
      permissions: actor?.permissionList() ?? [],
      isSuperAdmin: actor?.isSuperAdmin ?? false,
    },
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt.toISOString(),
  });
});
