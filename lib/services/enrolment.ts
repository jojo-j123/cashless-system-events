import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client';
import { nfcCards, teams } from '../db/schema';
import { ConflictError } from '../errors';
import type { AuditContext } from '../audit';
import { normaliseUid } from '../nfc/credentials';
import { createParticipant } from './provisioning';
import { registerCardForUser } from './cards';
import { topUpUser } from './wallet';

export interface EnrolInput {
  eventId: string;
  displayName: string;
  teamId?: string | null;
  /** Chip serial from the tap. */
  uid: string;
  /** Opening balance. Zero is allowed — the card can be topped up later. */
  topUpPoints: number;
  /** The admin performing the enrolment; the top-up is attributed to them. */
  createdBy: string;
}

export interface EnrolResult {
  userId: string;
  participantRef: string;
  cardId: string;
  cardRef: string;
  displayName: string;
  teamName: string | null;
  balance: number;
}

/**
 * The whole desk flow in one call: name, team, tag, opening balance.
 *
 * Three services own the three writes, and each is transactional on its own,
 * so this cannot be one atomic step — `topUpUser` in particular has to run in
 * its own transaction to take the idempotency lock that stops a retry issuing
 * points twice.
 *
 * What that costs is a torn enrolment if the process dies mid-way, and the
 * order below is chosen so the surviving state is always the harmless one: a
 * participant with no card, or a card with no points. Both are visible in the
 * admin lists and both are fixable from the UI. The reverse — points issued to
 * nobody — is not possible.
 *
 * The tag is checked for availability before anyone is created, so the common
 * retry (staff taps the same tag twice) fails before it makes a second person
 * rather than after.
 */
export async function enrolParticipantCard(
  db: Database,
  input: EnrolInput,
  idempotencyKey: string,
  context: AuditContext,
): Promise<EnrolResult> {
  const uid = normaliseUid(input.uid);

  const [taken] = await db
    .select({ cardRef: nfcCards.cardRef })
    .from(nfcCards)
    .where(and(eq(nfcCards.eventId, input.eventId), eq(nfcCards.uid, uid)))
    .limit(1);
  if (taken) {
    throw new ConflictError(
      `This tag is already registered as ${taken.cardRef}.`,
      'card_already_registered',
    );
  }

  const participant = await createParticipant(
    db,
    {
      eventId: input.eventId,
      displayName: input.displayName,
      teamId: input.teamId ?? null,
    },
    context,
  );

  const card = await registerCardForUser(
    db,
    { eventId: input.eventId, userId: participant.userId, uid },
    context,
  );

  let balance = 0;
  if (input.topUpPoints > 0) {
    const { result } = await topUpUser(
      db,
      {
        eventId: input.eventId,
        userId: participant.userId,
        amountPoints: input.topUpPoints,
        reason: 'Opening balance at enrolment',
        source: 'ADMIN_PANEL',
        createdBy: input.createdBy,
      },
      idempotencyKey,
      context,
    );
    balance = result.recipients[0]?.balanceAfter ?? input.topUpPoints;
  }

  const teamName = input.teamId
    ? ((
        await db
          .select({ name: teams.name })
          .from(teams)
          .where(eq(teams.id, input.teamId))
          .limit(1)
      )[0]?.name ?? null)
    : null;

  return {
    userId: participant.userId,
    participantRef: participant.participantRef,
    cardId: card.cardId,
    cardRef: card.cardRef,
    displayName: input.displayName.trim(),
    teamName,
    balance,
  };
}
