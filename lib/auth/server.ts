import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb, type Database } from '../db/client';
import { events } from '../db/schema';
import { Actor, loadActor } from '../authz/actor';
import { SESSION_COOKIE, resolveSession } from './session';
import type { Permission } from '../authz/permissions';

export interface PageSession {
  db: Database;
  actor: Actor;
  eventId: string;
  eventName: string;
  eventStatus: string;
}

/**
 * Server-side gate for pages.
 *
 * Rendering happens on the server with the actor already resolved, so a page a
 * user may not see is never sent to their browser at all. This is a usability
 * measure on top of the real control, which is the permission check inside
 * every API route.
 */
export async function requireSession(permission?: Permission): Promise<PageSession> {
  // `cookies()` must be awaited before anything touches the database. Reading it
  // is what opts a page out of static prerendering; until then Next treats the
  // render as build-time work, and `getDb()` would resolve DATABASE_URL on a
  // build machine that has no business holding it. Getting this order wrong
  // fails the build where the variable is absent, and silently couples the
  // build to the production database where it is present.
  const cookieBag = await cookies();
  const db = getDb();
  const session = await resolveSession(db, cookieBag.get(SESSION_COOKIE)?.value);
  if (!session) redirect('/login');

  const [event] = await db
    .select({ id: events.id, name: events.name, status: events.status })
    .from(events)
    .where(and(eq(events.status, 'ACTIVE'), isNull(events.archivedAt)))
    .orderBy(sql`${events.startsAt} nulls last`)
    .limit(1);

  const actor = await loadActor(db, session.userId, event?.id ?? null);
  if (!actor) redirect('/login');

  if (permission && !actor.canAnywhere(permission, event?.id ?? null)) {
    redirect('/me?denied=1');
  }

  return {
    db,
    actor,
    eventId: event?.id ?? '',
    eventName: event?.name ?? 'No active event',
    eventStatus: event?.status ?? 'DRAFT',
  };
}

/** Null instead of a redirect, for pages that render differently when signed out. */
export async function optionalSession(): Promise<PageSession | null> {
  // Cookies first — see the note in requireSession. This is the path `/` takes,
  // and it is where the build actually broke.
  const cookieBag = await cookies();
  const db = getDb();
  const session = await resolveSession(db, cookieBag.get(SESSION_COOKIE)?.value);
  if (!session) return null;

  const [event] = await db
    .select({ id: events.id, name: events.name, status: events.status })
    .from(events)
    .where(eq(events.status, 'ACTIVE'))
    .limit(1);

  const actor = await loadActor(db, session.userId, event?.id ?? null);
  if (!actor) return null;

  return {
    db,
    actor,
    eventId: event?.id ?? '',
    eventName: event?.name ?? 'No active event',
    eventStatus: event?.status ?? 'DRAFT',
  };
}
