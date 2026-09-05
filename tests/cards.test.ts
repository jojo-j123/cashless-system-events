import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb } from '../lib/db/client';
import { buildWorld, prepareDatabase, setSettings, type TestWorld } from './helpers';
import {
  assignCard,
  changeCardStatus,
  createCards,
  getCardHistory,
  replaceCard,
  resolveCard,
  unassignCard,
} from '../lib/services/cards';
import { cardTaps, nfcCards } from '../lib/db/schema';
import { fund, balanceOf } from './helpers';

let world: TestWorld;
const ctx = { requestId: 'test' };

beforeEach(async () => {
  const db = await prepareDatabase();
  world = await buildWorld(db, { tapCooldownMs: 0 });
});

afterAll(async () => {
  await closeDb();
});

async function spareCard(): Promise<{ cardId: string; token: string }> {
  const [card] = await createCards(world.db, { eventId: world.eventId, count: 1 }, ctx);
  if (!card) throw new Error('no card');
  return { cardId: card.cardId, token: card.token };
}

describe('card resolution', () => {
  it('resolves a token to the holder and their balance', async () => {
    await fund(world, world.participantId, 2_450);

    const resolved = await resolveCard(
      world.db,
      world.eventId,
      { kind: 'TOKEN', value: world.cardToken },
      ctx,
    );

    expect(resolved.userId).toBe(world.participantId);
    expect(resolved.displayName).toBe('Ahmed Hassan');
    expect(resolved.balance).toBe(2_450);
    expect(resolved.teamName).toBe('Team Red');
    expect(resolved.cardRef).toMatch(/^CARD-\d{4}-\d{6}$/);
  });

  it('never returns a secret in the resolved payload', async () => {
    const resolved = await resolveCard(
      world.db,
      world.eventId,
      { kind: 'TOKEN', value: world.cardToken },
      ctx,
    );
    const serialised = JSON.stringify(resolved);
    expect(serialised).not.toContain(world.cardToken);
    expect(serialised.toLowerCase()).not.toContain('tokenhash');
  });

  it('rejects an unknown token', async () => {
    await expect(
      resolveCard(world.db, world.eventId, { kind: 'TOKEN', value: 'not-a-real-token' }, ctx),
    ).rejects.toMatchObject({ code: 'card_not_found' });
  });

  it('rejects a suspended card', async () => {
    await changeCardStatus(
      world.db,
      { eventId: world.eventId, cardId: world.cardId, status: 'SUSPENDED', reason: 'Investigation' },
      ctx,
    );
    await expect(
      resolveCard(world.db, world.eventId, { kind: 'TOKEN', value: world.cardToken }, ctx),
    ).rejects.toMatchObject({ code: 'card_not_usable' });
  });

  it('disables a lost card immediately', async () => {
    await changeCardStatus(
      world.db,
      { eventId: world.eventId, cardId: world.cardId, status: 'LOST', reason: 'Left in a taxi' },
      ctx,
    );
    await expect(
      resolveCard(world.db, world.eventId, { kind: 'TOKEN', value: world.cardToken }, ctx),
    ).rejects.toMatchObject({ code: 'card_not_usable' });
  });

  it('rejects an unassigned card', async () => {
    const spare = await spareCard();
    await expect(
      resolveCard(world.db, world.eventId, { kind: 'TOKEN', value: spare.token }, ctx),
    ).rejects.toMatchObject({ code: 'card_not_assigned' });
  });

  it('refuses a bare chip UID unless the event opts in', async () => {
    await world.db
      .update(nfcCards)
      .set({ uid: 'AABBCCDD11223344' })
      .where(eq(nfcCards.id, world.cardId));

    // A UID is readable and clonable by any phone, so it is not a credential
    // by default.
    await expect(
      resolveCard(world.db, world.eventId, { kind: 'UID', value: 'AA:BB:CC:DD:11:22:33:44' }, ctx),
    ).rejects.toMatchObject({ code: 'card_not_found' });

    await setSettings(world, { allowUidOnlyResolution: true });
    const resolved = await resolveCard(
      world.db,
      world.eventId,
      { kind: 'UID', value: 'aa:bb:cc:dd:11:22:33:44' },
      ctx,
    );
    expect(resolved.userId).toBe(world.participantId);
  });

  it('rate limits a card tapped repeatedly', async () => {
    await setSettings(world, { tapCooldownMs: 5_000 });
    await resolveCard(world.db, world.eventId, { kind: 'TOKEN', value: world.cardToken }, ctx);
    await expect(
      resolveCard(world.db, world.eventId, { kind: 'TOKEN', value: world.cardToken }, ctx),
    ).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('logs every attempt, including rejected ones', async () => {
    await resolveCard(world.db, world.eventId, { kind: 'TOKEN', value: world.cardToken }, ctx);
    await resolveCard(world.db, world.eventId, { kind: 'TOKEN', value: 'bogus' }, ctx).catch(
      () => undefined,
    );

    const taps = await world.db
      .select({ outcome: cardTaps.outcome, fingerprint: cardTaps.credentialFingerprint })
      .from(cardTaps)
      .orderBy(cardTaps.createdAt);

    expect(taps.map((tap) => tap.outcome)).toEqual(['RESOLVED', 'INVALID_CREDENTIAL']);
    // The unresolvable credential is recorded as a hash, never in the clear.
    for (const tap of taps) {
      expect(tap.fingerprint).not.toContain(world.cardToken);
      expect(tap.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

describe('card lifecycle', () => {
  it('assigns, unassigns and reassigns', async () => {
    const spare = await spareCard();
    await assignCard(
      world.db,
      { eventId: world.eventId, cardId: spare.cardId, userId: world.otherParticipantId },
      ctx,
    );
    const resolved = await resolveCard(
      world.db,
      world.eventId,
      { kind: 'TOKEN', value: spare.token },
      ctx,
    );
    expect(resolved.userId).toBe(world.otherParticipantId);

    await unassignCard(
      world.db,
      { eventId: world.eventId, cardId: spare.cardId, reason: 'Returned at exit' },
      ctx,
    );
    await expect(
      resolveCard(world.db, world.eventId, { kind: 'TOKEN', value: spare.token }, ctx),
    ).rejects.toMatchObject({ code: 'card_not_assigned' });
  });

  it('will not assign a card that is already in use', async () => {
    await expect(
      assignCard(
        world.db,
        { eventId: world.eventId, cardId: world.cardId, userId: world.otherParticipantId },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'card_not_assignable' });
  });

  it('will not give one person two active cards', async () => {
    const spare = await spareCard();
    // The database enforces this with a partial unique index, so a race
    // between two staff members cannot slip a second card through.
    await expect(
      assignCard(
        world.db,
        { eventId: world.eventId, cardId: spare.cardId, userId: world.participantId },
        ctx,
      ),
    ).rejects.toThrow();
  });

  it('replaces a lost card while preserving the wallet exactly', async () => {
    await fund(world, world.participantId, 1_234);
    const replacement = await spareCard();

    await replaceCard(
      world.db,
      {
        eventId: world.eventId,
        oldCardId: world.cardId,
        newCardId: replacement.cardId,
        reason: 'Card lost at the main stage',
        retireAs: 'LOST',
      },
      ctx,
    );

    // Old card dead, new card live, balance untouched — the money never
    // lived on the card in the first place.
    await expect(
      resolveCard(world.db, world.eventId, { kind: 'TOKEN', value: world.cardToken }, ctx),
    ).rejects.toMatchObject({ code: 'card_not_usable' });

    const resolved = await resolveCard(
      world.db,
      world.eventId,
      { kind: 'TOKEN', value: replacement.token },
      ctx,
    );
    expect(resolved.userId).toBe(world.participantId);
    expect(resolved.balance).toBe(1_234);
    expect(await balanceOf(world, world.participantId)).toBe(1_234);
  });

  it('keeps a full history of every card action', async () => {
    await changeCardStatus(
      world.db,
      { eventId: world.eventId, cardId: world.cardId, status: 'SUSPENDED', reason: 'Suspicion' },
      ctx,
    );
    await changeCardStatus(
      world.db,
      { eventId: world.eventId, cardId: world.cardId, status: 'ACTIVE', reason: 'Cleared' },
      ctx,
    );

    const history = await getCardHistory(world.db, world.cardId);
    const actions = history.map((entry) => entry.action);
    expect(actions).toContain('assigned');
    expect(actions).toContain('status_suspended');
    expect(actions).toContain('status_active');
  });

  it('refuses to activate a card nobody holds', async () => {
    const spare = await spareCard();
    await expect(
      changeCardStatus(
        world.db,
        { eventId: world.eventId, cardId: spare.cardId, status: 'ACTIVE', reason: 'Premature' },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'card_not_assigned' });
  });
});
