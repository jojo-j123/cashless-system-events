import { redirect } from 'next/navigation';
import { optionalSession } from '@/lib/auth/server';

/**
 * Send each role to the surface they actually work in.
 *
 * Both checks ask "anywhere in this event" rather than naming a scope, because
 * a cashier's grants are scoped to the store they work: asking `can(...)` with
 * only an event would compare their store against `null` and answer false for
 * every cashier alive, landing the whole till staff on the participant
 * dashboard. The page each redirect leads to re-checks properly against the
 * real store, so nothing is widened by deciding the destination this way.
 */
export default async function HomePage(): Promise<never> {
  const session = await optionalSession();
  if (!session) redirect('/login');

  if (session.actor.canAnywhere('report.read', session.eventId)) redirect('/admin');
  if (session.actor.canAnywhere('pos.operate', session.eventId)) redirect('/pos');
  redirect('/me');
}
