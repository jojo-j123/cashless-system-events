import { randomUUID } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { getDb, type Database } from '../db/client';
import { events } from '../db/schema';
import { Actor, loadActor } from '../authz/actor';
import { CSRF_HEADER, SESSION_COOKIE, resolveSession } from '../auth/session';
import { hashToken } from '../auth/tokens';
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '../errors';
import type { AuditContext } from '../audit';

export interface RequestContext {
  db: Database;
  requestId: string;
  actor: Actor;
  sessionId: string;
  eventId: string;
  ipAddress: string | null;
  userAgent: string | null;
  audit: AuditContext;
}

/** Mutating methods must present a CSRF token and a same-origin Origin header. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildContext(request: NextRequest): Promise<RequestContext> {
  const db = getDb();
  const requestId = request.headers.get('x-request-id') ?? randomUUID();
  const headerBag = await headers();
  const cookieBag = await cookies();

  const ipAddress =
    headerBag.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    headerBag.get('x-real-ip') ??
    null;
  const userAgent = headerBag.get('user-agent');

  const session = await resolveSession(db, cookieBag.get(SESSION_COOKIE)?.value);
  if (!session) throw new UnauthenticatedError();

  if (UNSAFE_METHODS.has(request.method)) {
    assertSameOrigin(request);
    assertCsrf(request, session.csrfTokenHash);
  }

  const eventId = await resolveEventId(db, request, headerBag.get('x-event-id'));

  const actor = await loadActor(db, session.userId, eventId);
  if (!actor) throw new UnauthenticatedError();

  return {
    db,
    requestId,
    actor,
    sessionId: session.sessionId,
    eventId,
    ipAddress,
    userAgent,
    audit: {
      eventId,
      actorUserId: actor.userId,
      actorRole: actor.roleKeys.join(','),
      ipAddress,
      userAgent,
      requestId,
    },
  };
}

/**
 * Double-submit CSRF: the token is in a readable cookie AND must be echoed in
 * a header. A cross-site form post can carry the cookie but cannot read it to
 * set the header.
 */
function assertCsrf(request: NextRequest, expectedHash: string): void {
  const presented = request.headers.get(CSRF_HEADER);
  if (!presented || hashToken(presented) !== expectedHash) {
    throw new ForbiddenError('Your session could not be verified. Please refresh and try again.');
  }
}

function assertSameOrigin(request: NextRequest): void {
  const origin = request.headers.get('origin');
  if (!origin) return; // Same-origin fetches from some clients omit it.

  const allowed = (process.env.APP_ORIGIN ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const permitted = allowed.length > 0 ? allowed : [new URL(request.url).origin];

  if (!permitted.includes(origin)) {
    throw new ForbiddenError('This request came from an unrecognised origin.');
  }
}

/**
 * The event in play, from an explicit header/query or the single active event.
 * There is no hard-coded default: the platform is multi-event from the start.
 */
async function resolveEventId(
  db: Database,
  request: NextRequest,
  headerValue: string | null,
): Promise<string> {
  const explicit = headerValue ?? new URL(request.url).searchParams.get('eventId');
  if (explicit) {
    const [event] = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, explicit))
      .limit(1);
    if (!event) throw new NotFoundError('That event');
    return event.id;
  }

  const active = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.status, 'ACTIVE'))
    .limit(2);

  if (active.length === 0) throw new NotFoundError('An active event');
  if (active.length > 1) {
    throw new NotFoundError(
      'The event',
      { hint: 'More than one event is active; pass an x-event-id header.' },
    );
  }
  return active[0]!.id;
}
