import { redirect } from 'next/navigation';
import { optionalSession } from '@/lib/auth/server';

/** Send each role to the surface they actually work in. */
export default async function HomePage(): Promise<never> {
  const session = await optionalSession();
  if (!session) redirect('/login');

  if (session.actor.can('report.read', { eventId: session.eventId })) redirect('/admin');
  if (session.actor.canAny(['pos.operate'], { eventId: session.eventId })) redirect('/pos');
  redirect('/me');
}
