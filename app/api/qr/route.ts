import { and, eq } from 'drizzle-orm';
import { route } from '@/lib/api/handler';
import { ok } from '@/lib/api/responses';
import { eventParticipants, users } from '@/lib/db/schema';
import QRCode from 'qrcode';
import { issueQrToken } from '@/lib/nfc/qr';
import { getEventSettings } from '@/lib/settings/service';
import { NotFoundError } from '@/lib/errors';

/**
 * Issue a short-lived QR credential for the signed-in participant.
 *
 * The payload carries a public participant reference and an expiry, nothing
 * else — no name, no id, no balance. It is always for the caller themselves.
 */
export const GET = route({ permission: 'participant.read.self' }, async ({ context }) => {
  const [participant] = await context.db
    .select({ ref: eventParticipants.participantRef, secret: users.qrSecret })
    .from(eventParticipants)
    .innerJoin(users, eq(users.id, eventParticipants.userId))
    .where(
      and(
        eq(eventParticipants.eventId, context.eventId),
        eq(eventParticipants.userId, context.actor.userId),
      ),
    )
    .limit(1);

  if (!participant) throw new NotFoundError('Your participant record');

  const settings = await getEventSettings(context.db, context.eventId);
  const { token, expiresAt } = issueQrToken(
    participant.ref,
    participant.secret,
    settings.qrTokenTtlSeconds,
  );

  // Rendered server-side to a real, scannable QR: the client never needs a
  // QR library, and the payload is encoded exactly as the scanner will read it.
  const svg = await QRCode.toString(token, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 240,
  });

  return ok({
    token,
    svg,
    expiresAt: expiresAt.toISOString(),
    refreshInSeconds: Math.max(5, settings.qrTokenTtlSeconds - 10),
  });
});
