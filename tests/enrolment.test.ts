import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb } from '../lib/db/client';
import { buildWorld, prepareDatabase, balanceOf, type TestWorld } from './helpers';
import { enrolParticipantCard } from '../lib/services/enrolment';
import { resolveCard } from '../lib/services/cards';
import { verifyLedgerIntegrity } from '../lib/services/ledger';
import { nfcCards, users } from '../lib/db/schema';

let world: TestWorld;
const ctx = { requestId: 'test' };

beforeEach(async () => {
  const db = await prepareDatabase();
  world = await buildWorld(db, { tapCooldownMs: 0, allowUidOnlyResolution: true });
});

afterAll(async () => {
  await closeDb();
});

let uidCounter = 0;
function freshUid(): string {
  uidCounter += 1;
  return `04A1B2C3D4E5${uidCounter.toString(16).padStart(2, '0').toUpperCase()}`;
}

function enrol(overrides: Partial<Parameters<typeof enrolParticipantCard>[1]> = {}) {
  return enrolParticipantCard(
    world.db,
    {
      eventId: world.eventId,
      displayName: 'Desk Walkup',
      teamId: world.teamId,
      uid: freshUid(),
      topUpPoints: 500,
      createdBy: world.financeId,
      ...overrides,
    },
    `enrol-${Math.random()}`,
    ctx,
  );
}

describe('desk enrolment', () => {
  it('creates the person, the card and the opening balance in one call', async () => {
    const result = await enrol();

    expect(result.displayName).toBe('Desk Walkup');
    expect(result.teamName).toBe('Team Red');
    expect(result.balance).toBe(500);
    expect(result.cardRef).toMatch(/^CARD-/);
    expect(await balanceOf(world, result.userId)).toBe(500);
  });

  it('produces a card that actually resolves at a terminal', async () => {
    const uid = freshUid();
    const result = await enrol({ uid });

    const resolved = await resolveCard(world.db, world.eventId, { kind: 'UID', value: uid }, ctx);

    expect(resolved.userId).toBe(result.userId);
    expect(resolved.balance).toBe(500);
  });

  it('accepts a zero opening balance', async () => {
    const result = await enrol({ topUpPoints: 0 });

    expect(result.balance).toBe(0);
    expect(await balanceOf(world, result.userId)).toBe(0);
  });

  it('normalises a UID that the reader punctuates', async () => {
    const result = await enrol({ uid: '04:a1:b2:c3:d4:e5:99' });

    const [card] = await world.db
      .select({ uid: nfcCards.uid })
      .from(nfcCards)
      .where(eq(nfcCards.id, result.cardId))
      .limit(1);

    expect(card?.uid).toBe('04A1B2C3D4E599');
  });

  it('refuses a tag that is already registered, and creates nobody', async () => {
    const uid = freshUid();
    await enrol({ uid });

    const before = await world.db.select({ id: users.id }).from(users);

    await expect(enrol({ uid, displayName: 'Second Person' })).rejects.toMatchObject({
      code: 'card_already_registered',
    });

    // The tag check runs before the participant is created, so a repeated tap
    // does not leave an orphan person behind.
    const after = await world.db.select({ id: users.id }).from(users);
    expect(after.length).toBe(before.length);
  });

  it('rejects something that is not a card UID', async () => {
    await expect(enrol({ uid: 'nope' })).rejects.toMatchObject({ code: 'card_uid_invalid' });
  });

  it('leaves the ledger balanced and every account reconciled', async () => {
    await enrol({ topUpPoints: 300 });
    await enrol({ topUpPoints: 700 });

    // Points issued at the desk are real double-entry movements, not a number
    // written onto a wallet. If enrolment skipped the counter-entry this drifts.
    const integrity = await verifyLedgerIntegrity(world.db, world.eventId);

    expect(integrity.balanced).toBe(true);
    expect(integrity.eventSum).toBe(0);
    expect(integrity.driftingAccounts).toBe(0);
  });

  it('gives each enrolled person exactly one active card', async () => {
    const result = await enrol();

    const cards = await world.db
      .select({ id: nfcCards.id })
      .from(nfcCards)
      .where(and(eq(nfcCards.assignedUserId, result.userId), eq(nfcCards.status, 'ACTIVE')));

    expect(cards.length).toBe(1);
  });
});
