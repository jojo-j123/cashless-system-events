import { redirect } from 'next/navigation';
import { optionalSession } from '@/lib/auth/server';
import { getEventSettings } from '@/lib/settings/service';
import { landingPathFor } from '@/lib/admin/nav';

/**
 * Send each role to the surface they actually work in.
 *
 * Derived from the same list that draws the console nav, so the place somebody
 * lands is always something they can open. Naming the destinations here instead
 * meant a role the nav understood perfectly well could still be sent to a page
 * that bounced it.
 */
export default async function HomePage(): Promise<never> {
  const session = await optionalSession();
  if (!session) redirect('/login');

  const settings = await getEventSettings(session.db, session.eventId);
  redirect(landingPathFor(session.actor, session.eventId, settings.gameModeEnabled));
}
