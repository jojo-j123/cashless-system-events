import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database, Executor, Transaction } from '../db/client';
import {
  accounts,
  cardEvents,
  cardTaps,
  eventParticipants,
  nfcCards,
  teamMembers,
  teams,
  users,
} from '../db/schema';
import type { cardStatus, tapOutcome } from '../db/schema';
import { recordAudit, type AuditContext } from '../audit';
import { nextRefs } from '../core/refs';
import { generateToken, hashToken } from '../auth/tokens';
import { getEventSettings } from '../settings/service';
import {
  CardNotAssignedError,
  CardNotFoundError,
  CardNotUsableError,
  ConflictError,
  NotFoundError,
  RateLimitedError,
} from '../errors';
import {
  isPlausibleUid,
  normaliseUid,
  type CardCredential,
} from '../nfc/credentials';
import { parseQrToken, verifyQrToken } from '../nfc/qr';
import { getUserAccount } from './ledger';

export type CardStatus = (typeof cardStatus.enumValues)[number];
type TapOutcome = (typeof tapOutcome.enumValues)[number];

/** What a terminal gets back after a successful tap. Never includes a secret. */
export interface ResolvedCard {
  cardId: string;
  cardRef: string;
  cardStatus: CardStatus;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  participantRef: string;
  teamId: string | null;
  teamName: string | null;
  teamColor: string | null;
  accountId: string;
  balance: number;
  lowBalance: boolean;
}

export interface ResolveContext extends AuditContext {
  terminalId?: string | null;
  storeId?: string | null;
}

/**
 * Turn a presented credential into an account.
 *
 * This is the single entry point for every tap, from every reader type,
 * including the development simulator. There is no path that skips the status
 * checks below.
 *
 * Every attempt — resolved or rejected — is written to `card_taps`, which
 * powers rate limiting, clone detection and support triage.
 */
export async function resolveCard(
  db: Database,
  eventId: string,
  credential: CardCredential,
  context: ResolveContext = {},
): Promise<ResolvedCard> {
  const settings = await getEventSettings(db, eventId);
  const fingerprintValue = hashToken(`${credential.kind}:${credential.value}`).slice(0, 32);

  const record = async (outcome: TapOutcome, cardId: string | null): Promise<void> => {
    await db.insert(cardTaps).values({
      eventId,
      cardId,
      credentialKind: credential.kind,
      credentialFingerprint: fingerprintValue,
      outcome,
      terminalId: context.terminalId ?? null,
      storeId: context.storeId ?? null,
      actorUserId: context.actorUserId ?? null,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
    });
  };

  const card = await lookupCard(db, eventId, credential, settings.allowUidOnlyResolution);
  if (!card) {
    await record('INVALID_CREDENTIAL', null);
    throw new CardNotFoundError();
  }

  // Replay / clone guard: a burst of taps on one card is either a stuck reader
  // or two cards answering to the same identity. Both need stopping.
  const recentTaps = await db.execute<{ count: string; last_tap: string | null }>(sql`
    select count(*)::text as count,
           max(created_at)::text as last_tap
      from card_taps
     where card_id = ${card.id}
       and created_at > now() - interval '1 minute'
  `);
  const tapCount = Number(recentTaps.rows[0]?.count ?? 0);
  const lastTapAt = recentTaps.rows[0]?.last_tap;

  if (tapCount >= settings.maxTapsPerCardPerMinute) {
    await record('RATE_LIMITED', card.id);
    throw new RateLimitedError(60, 'This card has been tapped too many times. Please wait.');
  }
  if (
    lastTapAt !== null &&
    lastTapAt !== undefined &&
    Date.now() - new Date(lastTapAt).getTime() < settings.tapCooldownMs
  ) {
    await record('RATE_LIMITED', card.id);
    throw new RateLimitedError(1, 'Card tapped twice too quickly. Try again.');
  }

  if (card.status === 'UNASSIGNED') {
    await record('CARD_NOT_ASSIGNED', card.id);
    throw new CardNotAssignedError();
  }

  const rejection = statusRejection(card.status);
  if (rejection) {
    await record(rejection.outcome, card.id);
    throw new CardNotUsableError(card.status, rejection.message);
  }

  if (card.expiresAt !== null && card.expiresAt.getTime() <= Date.now()) {
    await record('CARD_EXPIRED', card.id);
    throw new CardNotUsableError('EXPIRED', 'This card has expired.');
  }

  if (card.assignedUserId === null) {
    await record('CARD_NOT_ASSIGNED', card.id);
    throw new CardNotAssignedError();
  }

  const holder = await loadHolder(db, eventId, card.assignedUserId);
  if (!holder) {
    await record('CARD_NOT_ASSIGNED', card.id);
    throw new CardNotAssignedError();
  }
  if (holder.userStatus !== 'ACTIVE') {
    await record('USER_SUSPENDED', card.id);
    throw new CardNotUsableError('USER_SUSPENDED', 'This account is suspended.');
  }

  await record('RESOLVED', card.id);
  await db
    .update(nfcCards)
    .set({ lastUsedAt: new Date() })
    .where(eq(nfcCards.id, card.id));

  return {
    cardId: card.id,
    cardRef: card.cardRef,
    cardStatus: card.status,
    userId: holder.userId,
    displayName: holder.displayName,
    avatarUrl: holder.avatarUrl,
    participantRef: holder.participantRef,
    teamId: holder.teamId,
    teamName: holder.teamName,
    teamColor: holder.teamColor,
    accountId: holder.accountId,
    balance: holder.balance,
    lowBalance: holder.balance < settings.lowBalanceThreshold,
  };
}

function statusRejection(
  status: CardStatus,
): { outcome: TapOutcome; message: string } | null {
  switch (status) {
    case 'ACTIVE':
      return null;
    case 'UNASSIGNED':
      return { outcome: 'CARD_NOT_ASSIGNED', message: 'This card is not linked to an account yet.' };
    case 'SUSPENDED':
      return { outcome: 'CARD_SUSPENDED', message: 'This card is suspended. Please see event staff.' };
    case 'LOST':
      return { outcome: 'CARD_LOST', message: 'This card was reported lost and cannot be used.' };
    case 'REPLACED':
      return { outcome: 'CARD_DEACTIVATED', message: 'This card was replaced. Please use the new card.' };
    case 'DEACTIVATED':
      return { outcome: 'CARD_DEACTIVATED', message: 'This card has been deactivated.' };
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

type CardRow = {
  id: string;
  cardRef: string;
  status: CardStatus;
  assignedUserId: string | null;
  expiresAt: Date | null;
};

async function lookupCard(
  db: Executor,
  eventId: string,
  credential: CardCredential,
  allowUidOnly: boolean,
): Promise<CardRow | null> {
  const columns = {
    id: nfcCards.id,
    cardRef: nfcCards.cardRef,
    status: nfcCards.status,
    assignedUserId: nfcCards.assignedUserId,
    expiresAt: nfcCards.expiresAt,
  };

  switch (credential.kind) {
    case 'TOKEN': {
      const [row] = await db
        .select(columns)
        .from(nfcCards)
        .where(
          and(eq(nfcCards.eventId, eventId), eq(nfcCards.tokenHash, hashToken(credential.value))),
        )
        .limit(1);
      return row ?? null;
    }

    case 'UID': {
      // A bare chip UID is a weak credential: any phone can read and replay it.
      // Only honoured when the operator has consciously accepted that.
      if (!allowUidOnly) return null;
      if (!isPlausibleUid(credential.value)) return null;
      const [row] = await db
        .select(columns)
        .from(nfcCards)
        .where(
          and(eq(nfcCards.eventId, eventId), eq(nfcCards.uid, normaliseUid(credential.value))),
        )
        .limit(1);
      return row ?? null;
    }

    case 'QR': {
      const parsed = parseQrToken(credential.value);
      if (!parsed) return null;

      const [holder] = await db
        .select({ userId: users.id, qrSecret: users.qrSecret })
        .from(eventParticipants)
        .innerJoin(users, eq(users.id, eventParticipants.userId))
        .where(
          and(
            eq(eventParticipants.eventId, eventId),
            eq(eventParticipants.participantRef, parsed.participantRef),
          ),
        )
        .limit(1);
      if (!holder || !verifyQrToken(parsed, holder.qrSecret)) return null;

      const [row] = await db
        .select(columns)
        .from(nfcCards)
        .where(
          and(
            eq(nfcCards.eventId, eventId),
            eq(nfcCards.assignedUserId, holder.userId),
            eq(nfcCards.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      // A participant with no card can still transact by QR: synthesise a
      // virtual card row so the caller's flow is identical either way.
      return row ?? virtualCardFor(holder.userId);
    }

    case 'MANUAL_REF': {
      const [row] = await db
        .select(columns)
        .from(nfcCards)
        .where(
          and(eq(nfcCards.eventId, eventId), eq(nfcCards.cardRef, credential.value.trim().toUpperCase())),
        )
        .limit(1);
      return row ?? null;
    }

    default: {
      const exhaustive: never = credential.kind;
      return exhaustive;
    }
  }
}

/** A QR holder with no physical card still needs a card-shaped result. */
function virtualCardFor(userId: string): CardRow {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    cardRef: 'QR-ONLY',
    status: 'ACTIVE',
    assignedUserId: userId,
    expiresAt: null,
  };
}

async function loadHolder(
  db: Executor,
  eventId: string,
  userId: string,
): Promise<{
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  userStatus: string;
  participantRef: string;
  teamId: string | null;
  teamName: string | null;
  teamColor: string | null;
  accountId: string;
  balance: number;
} | null> {
  const [row] = await db
    .select({
      userId: users.id,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      userStatus: users.status,
      participantRef: eventParticipants.participantRef,
      teamId: teams.id,
      teamName: teams.name,
      teamColor: teams.color,
      accountId: accounts.id,
      balance: accounts.balance,
    })
    .from(users)
    .innerJoin(
      eventParticipants,
      and(eq(eventParticipants.userId, users.id), eq(eventParticipants.eventId, eventId)),
    )
    .innerJoin(
      accounts,
      and(
        eq(accounts.ownerUserId, users.id),
        eq(accounts.eventId, eventId),
        eq(accounts.type, 'USER_SPENDABLE'),
      ),
    )
    .leftJoin(
      teamMembers,
      and(eq(teamMembers.userId, users.id), eq(teamMembers.eventId, eventId)),
    )
    .leftJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(users.id, userId))
    .limit(1);

  return row ?? null;
}

/* -------------------------------------------------------------------------- */
/* Card lifecycle                                                             */
/* -------------------------------------------------------------------------- */

export interface IssuedCard {
  cardId: string;
  cardRef: string;
  /** The secret to write to the chip. Returned exactly once, never stored. */
  token: string;
}

export async function createCards(
  db: Database,
  input: {
    eventId: string;
    count: number;
    technology?: 'NTAG213' | 'NTAG215' | 'NTAG216' | 'MIFARE_CLASSIC' | 'DESFIRE_EV2' | 'QR_ONLY' | 'OTHER';
    batchLabel?: string | null;
  },
  context: AuditContext,
): Promise<IssuedCard[]> {
  if (input.count < 1 || input.count > 5_000) {
    throw new ConflictError('Cards must be created in batches of 1 to 5,000.');
  }

  return db.transaction(async (tx) => {
    const refs = await nextRefs(tx, 'card', input.count);
    const issued: IssuedCard[] = [];

    const values = refs.map((cardRef) => {
      const token = generateToken(32);
      issued.push({ cardId: '', cardRef, token });
      return {
        eventId: input.eventId,
        cardRef,
        tokenHash: hashToken(token),
        tokenLast4: token.slice(-4),
        technology: input.technology ?? ('NTAG213' as const),
        batchLabel: input.batchLabel ?? null,
        status: 'UNASSIGNED' as const,
        createdBy: context.actorUserId ?? null,
      };
    });

    const rows = await tx.insert(nfcCards).values(values).returning({
      id: nfcCards.id,
      cardRef: nfcCards.cardRef,
    });

    const idByRef = new Map(rows.map((row) => [row.cardRef, row.id]));
    for (const card of issued) {
      card.cardId = idByRef.get(card.cardRef) ?? '';
    }

    await recordAudit(tx, {
      ...context,
      eventId: input.eventId,
      action: 'card.batch_created',
      targetType: 'nfc_card_batch',
      after: { count: input.count, batchLabel: input.batchLabel },
    });

    return issued;
  });
}

export async function assignCard(
  db: Database,
  input: { eventId: string; cardId: string; userId: string },
  context: AuditContext,
): Promise<void> {
  await db.transaction(async (tx) => {
    const card = await lockCard(tx, input.eventId, input.cardId);

    if (card.status !== 'UNASSIGNED') {
      throw new ConflictError(
        card.assignedUserId === input.userId
          ? 'This card is already linked to that participant.'
          : `This card cannot be assigned while it is ${card.status.toLowerCase()}.`,
        'card_not_assignable',
      );
    }

    // The participant must exist in this event and have a wallet.
    await getUserAccount(tx, input.eventId, input.userId);

    await tx
      .update(nfcCards)
      .set({
        assignedUserId: input.userId,
        assignedAt: new Date(),
        unassignedAt: null,
        status: 'ACTIVE',
      })
      .where(eq(nfcCards.id, input.cardId));

    await writeCardEvent(tx, {
      eventId: input.eventId,
      cardId: input.cardId,
      action: 'assigned',
      fromStatus: card.status,
      toStatus: 'ACTIVE',
      userId: input.userId,
      actorUserId: context.actorUserId ?? null,
      reason: null,
    });

    await recordAudit(tx, {
      ...context,
      eventId: input.eventId,
      action: 'card.assigned',
      targetType: 'nfc_card',
      targetId: input.cardId,
      before: { status: card.status, assignedUserId: card.assignedUserId },
      after: { status: 'ACTIVE', assignedUserId: input.userId },
    });
  });
}

export async function unassignCard(
  db: Database,
  input: { eventId: string; cardId: string; reason: string },
  context: AuditContext,
): Promise<void> {
  await db.transaction(async (tx) => {
    const card = await lockCard(tx, input.eventId, input.cardId);
    if (card.assignedUserId === null) {
      throw new ConflictError('This card is not linked to anyone.', 'card_not_assigned');
    }

    await tx
      .update(nfcCards)
      .set({ assignedUserId: null, unassignedAt: new Date(), status: 'UNASSIGNED' })
      .where(eq(nfcCards.id, input.cardId));

    await writeCardEvent(tx, {
      eventId: input.eventId,
      cardId: input.cardId,
      action: 'unassigned',
      fromStatus: card.status,
      toStatus: 'UNASSIGNED',
      userId: card.assignedUserId,
      actorUserId: context.actorUserId ?? null,
      reason: input.reason,
    });

    await recordAudit(tx, {
      ...context,
      eventId: input.eventId,
      action: 'card.unassigned',
      targetType: 'nfc_card',
      targetId: input.cardId,
      before: { status: card.status, assignedUserId: card.assignedUserId },
      after: { status: 'UNASSIGNED', assignedUserId: null },
      metadata: { reason: input.reason },
    });
  });
}

/**
 * Status changes. The wallet is never touched: a lost card is a lost *key*,
 * not lost money, which is exactly why the balance lives in the database.
 */
export async function changeCardStatus(
  db: Database,
  input: {
    eventId: string;
    cardId: string;
    status: Extract<CardStatus, 'ACTIVE' | 'SUSPENDED' | 'LOST' | 'DEACTIVATED'>;
    reason: string;
  },
  context: AuditContext,
): Promise<void> {
  await db.transaction(async (tx) => {
    const card = await lockCard(tx, input.eventId, input.cardId);

    if (card.status === 'REPLACED') {
      throw new ConflictError(
        'This card was replaced and can no longer change status.',
        'card_replaced',
      );
    }
    if (input.status === 'ACTIVE' && card.assignedUserId === null) {
      throw new ConflictError(
        'Link the card to a participant before activating it.',
        'card_not_assigned',
      );
    }
    if (card.status === input.status) return;

    await tx
      .update(nfcCards)
      .set({ status: input.status })
      .where(eq(nfcCards.id, input.cardId));

    await writeCardEvent(tx, {
      eventId: input.eventId,
      cardId: input.cardId,
      action: `status_${input.status.toLowerCase()}`,
      fromStatus: card.status,
      toStatus: input.status,
      userId: card.assignedUserId,
      actorUserId: context.actorUserId ?? null,
      reason: input.reason,
    });

    await recordAudit(tx, {
      ...context,
      eventId: input.eventId,
      action: `card.${input.status.toLowerCase()}`,
      targetType: 'nfc_card',
      targetId: input.cardId,
      before: { status: card.status },
      after: { status: input.status },
      metadata: { reason: input.reason },
    });
  });
}

/**
 * Replace a card, carrying the participant's account across untouched.
 *
 * The old card is retired and the new one activated in one transaction, so
 * there is never a moment where both work or neither does.
 */
export async function replaceCard(
  db: Database,
  input: {
    eventId: string;
    oldCardId: string;
    newCardId: string;
    reason: string;
    retireAs?: Extract<CardStatus, 'LOST' | 'REPLACED' | 'DEACTIVATED'>;
  },
  context: AuditContext,
): Promise<{ userId: string }> {
  return db.transaction(async (tx) => {
    // Lock in id order to stay consistent with every other multi-row lock.
    const [firstId, secondId] = [input.oldCardId, input.newCardId].sort();
    if (!firstId || !secondId || firstId === secondId) {
      throw new ConflictError('The replacement must be a different card.', 'card_same');
    }
    await lockCard(tx, input.eventId, firstId);
    await lockCard(tx, input.eventId, secondId);

    const oldCard = await readCard(tx, input.eventId, input.oldCardId);
    const newCard = await readCard(tx, input.eventId, input.newCardId);

    if (oldCard.assignedUserId === null) {
      throw new ConflictError('The old card is not linked to anyone.', 'card_not_assigned');
    }
    if (newCard.status !== 'UNASSIGNED') {
      throw new ConflictError('The replacement card is already in use.', 'card_not_assignable');
    }

    const userId = oldCard.assignedUserId;
    const retireAs = input.retireAs ?? 'REPLACED';

    // Release the old card first: the partial unique index permits only one
    // ACTIVE card per participant, so the order matters.
    await tx
      .update(nfcCards)
      .set({
        status: retireAs,
        assignedUserId: null,
        unassignedAt: new Date(),
        replacedByCardId: input.newCardId,
      })
      .where(eq(nfcCards.id, input.oldCardId));

    await tx
      .update(nfcCards)
      .set({ status: 'ACTIVE', assignedUserId: userId, assignedAt: new Date() })
      .where(eq(nfcCards.id, input.newCardId));

    await writeCardEvent(tx, {
      eventId: input.eventId,
      cardId: input.oldCardId,
      action: 'replaced_by',
      fromStatus: oldCard.status,
      toStatus: retireAs,
      userId,
      actorUserId: context.actorUserId ?? null,
      reason: input.reason,
      metadata: { replacementCardId: input.newCardId },
    });
    await writeCardEvent(tx, {
      eventId: input.eventId,
      cardId: input.newCardId,
      action: 'replacement_for',
      fromStatus: newCard.status,
      toStatus: 'ACTIVE',
      userId,
      actorUserId: context.actorUserId ?? null,
      reason: input.reason,
      metadata: { previousCardId: input.oldCardId },
    });

    await recordAudit(tx, {
      ...context,
      eventId: input.eventId,
      action: 'card.replaced',
      targetType: 'nfc_card',
      targetId: input.oldCardId,
      before: { oldCardStatus: oldCard.status },
      after: { oldCardStatus: retireAs, newCardId: input.newCardId, userId },
      metadata: { reason: input.reason },
    });

    return { userId };
  });
}

async function lockCard(
  tx: Transaction,
  eventId: string,
  cardId: string,
): Promise<{ status: CardStatus; assignedUserId: string | null }> {
  const rows = await tx.execute<{ status: CardStatus; assigned_user_id: string | null }>(sql`
    select status, assigned_user_id
      from nfc_cards
     where id = ${cardId} and event_id = ${eventId}
       for update
  `);
  const row = rows.rows[0];
  if (!row) throw new NotFoundError('That card');
  return { status: row.status, assignedUserId: row.assigned_user_id };
}

async function readCard(
  tx: Executor,
  eventId: string,
  cardId: string,
): Promise<{ status: CardStatus; assignedUserId: string | null }> {
  const [row] = await tx
    .select({ status: nfcCards.status, assignedUserId: nfcCards.assignedUserId })
    .from(nfcCards)
    .where(and(eq(nfcCards.id, cardId), eq(nfcCards.eventId, eventId)))
    .limit(1);
  if (!row) throw new NotFoundError('That card');
  return row;
}

async function writeCardEvent(
  tx: Executor,
  entry: {
    eventId: string;
    cardId: string;
    action: string;
    fromStatus: CardStatus | null;
    toStatus: CardStatus | null;
    userId: string | null;
    actorUserId: string | null;
    reason: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(cardEvents).values({
    eventId: entry.eventId,
    cardId: entry.cardId,
    action: entry.action,
    fromStatus: entry.fromStatus,
    toStatus: entry.toStatus,
    userId: entry.userId,
    actorUserId: entry.actorUserId,
    reason: entry.reason,
    metadata: entry.metadata ?? {},
  });
}

export async function getCardHistory(
  db: Executor,
  cardId: string,
): Promise<(typeof cardEvents.$inferSelect)[]> {
  return db
    .select()
    .from(cardEvents)
    .where(eq(cardEvents.cardId, cardId))
    .orderBy(desc(cardEvents.createdAt))
    .limit(200);
}
