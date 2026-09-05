import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb } from '../lib/db/client';
import {
  balanceOf,
  buildWorld,
  countFulfilled,
  countRows,
  inParallel,
  prepareDatabase,
  rejectionCodes,
  type TestWorld,
} from './helpers';
import {
  awardChallenge,
  createChallenge,
  listChallenges,
  setChallengeStatus,
} from '../lib/services/challenges';
import { verifyLedgerIntegrity } from '../lib/services/ledger';
import { accounts } from '../lib/db/schema';
import { updateEventSettings } from '../lib/settings/service';
import { invalidateSettingsCache } from '../lib/settings/service';

let world: TestWorld;

const ctx = { actorUserId: null, requestId: 'test' };

beforeEach(async () => {
  const db = await prepareDatabase();
  // Challenges are a game surface, so the world for these tests is a game event.
  world = await buildWorld(db, { gameModeEnabled: true });
});

afterAll(async () => {
  await closeDb();
});

async function activeChallenge(
  overrides: Partial<Parameters<typeof createChallenge>[1]> = {},
): Promise<string> {
  const { challengeId } = await createChallenge(
    world.db,
    {
      eventId: world.eventId,
      name: 'Find the flag',
      slug: `find-the-flag-${Math.random().toString(36).slice(2, 8)}`,
      rewardPoints: 100,
      ...overrides,
    },
    ctx,
  );
  await setChallengeStatus(
    world.db,
    { eventId: world.eventId, challengeId, status: 'ACTIVE' },
    ctx,
  );
  return challengeId;
}

async function scoreOf(userId: string): Promise<number> {
  const [row] = await world.db
    .select({ balance: accounts.balance })
    .from(accounts)
    .where(
      and(
        eq(accounts.eventId, world.eventId),
        eq(accounts.ownerUserId, userId),
        eq(accounts.type, 'USER_SCORE'),
      ),
    );
  return Number(row?.balance ?? 0);
}

async function teamScoreOf(teamId: string): Promise<number> {
  const [row] = await world.db
    .select({ balance: accounts.balance })
    .from(accounts)
    .where(
      and(
        eq(accounts.eventId, world.eventId),
        eq(accounts.ownerTeamId, teamId),
        eq(accounts.type, 'TEAM_SCORE'),
      ),
    );
  return Number(row?.balance ?? 0);
}

describe('authoring challenges', () => {
  it('a new challenge starts as a draft with no completions', async () => {
    const { challengeId } = await createChallenge(
      world.db,
      {
        eventId: world.eventId,
        name: 'Find the flag',
        slug: 'find-the-flag',
        rewardPoints: 100,
        rewardScorePoints: 50,
      },
      ctx,
    );

    const [challenge] = await listChallenges(world.db, world.eventId);
    expect(challenge?.id).toBe(challengeId);
    expect(challenge?.status).toBe('DRAFT');
    expect(challenge?.completions).toBe(0);
  });

  it('refuses a challenge that awards nothing', async () => {
    await expect(
      createChallenge(
        world.db,
        {
          eventId: world.eventId,
          name: 'Pointless',
          slug: 'pointless',
          rewardPoints: 0,
          rewardScorePoints: 0,
        },
        ctx,
      ),
    ).rejects.toThrow(/points, score, or both/i);
  });

  it('refuses a duplicate slug within the event', async () => {
    await createChallenge(
      world.db,
      { eventId: world.eventId, name: 'One', slug: 'dup', rewardPoints: 10 },
      ctx,
    );
    await expect(
      createChallenge(
        world.db,
        { eventId: world.eventId, name: 'Two', slug: 'dup', rewardPoints: 10 },
        ctx,
      ),
    ).rejects.toThrow(/already exists/i);
  });

  it('refuses a window that closes before it opens', async () => {
    await expect(
      createChallenge(
        world.db,
        {
          eventId: world.eventId,
          name: 'Backwards',
          slug: 'backwards',
          rewardPoints: 10,
          startsAt: new Date('2026-06-02'),
          endsAt: new Date('2026-06-01'),
        },
        ctx,
      ),
    ).rejects.toThrow(/close before it opens/i);
  });

  it('an ended challenge cannot be reopened', async () => {
    const challengeId = await activeChallenge();
    await setChallengeStatus(
      world.db,
      { eventId: world.eventId, challengeId, status: 'ENDED' },
      ctx,
    );
    await expect(
      setChallengeStatus(
        world.db,
        { eventId: world.eventId, challengeId, status: 'ACTIVE' },
        ctx,
      ),
    ).rejects.toThrow(/cannot be reopened/i);
  });
});

describe('challenges belong to game mode', () => {
  it('a normal event cannot create or award them', async () => {
    const challengeId = await activeChallenge();

    await updateEventSettings(world.db, world.eventId, { gameModeEnabled: false }, null);
    invalidateSettingsCache(world.eventId);

    await expect(
      createChallenge(
        world.db,
        { eventId: world.eventId, name: 'Nope', slug: 'nope', rewardPoints: 10 },
        ctx,
      ),
    ).rejects.toThrow(/not running a game/i);

    await expect(
      awardChallenge(
        world.db,
        {
          eventId: world.eventId,
          challengeId,
          userId: world.participantId,
          awardedBy: world.adminId,
        },
        'award-standard-event',
        ctx,
      ),
    ).rejects.toThrow(/not running a game/i);
  });
});

describe('awarding a challenge', () => {
  it('pays spendable points and moves both leaderboards', async () => {
    const challengeId = await activeChallenge({ rewardPoints: 100, rewardScorePoints: 40 });
    const before = await balanceOf(world, world.participantId);

    const { result } = await awardChallenge(
      world.db,
      {
        eventId: world.eventId,
        challengeId,
        userId: world.participantId,
        awardedBy: world.adminId,
      },
      'award-1',
      ctx,
    );

    expect(result.awardedPoints).toBe(100);
    expect(result.completionIndex).toBe(1);
    expect(await balanceOf(world, world.participantId)).toBe(before + 100);

    // Individual and team boards read two different accounts, so an award has
    // to credit both or one of the two screens silently stays at zero.
    expect(await scoreOf(world.participantId)).toBe(40);
    expect(await teamScoreOf(world.teamId)).toBe(40);

    expect((await verifyLedgerIntegrity(world.db, world.eventId)).balanced).toBe(true);
  });

  it('a score-only challenge pays no spendable points', async () => {
    const challengeId = await activeChallenge({ rewardPoints: 0, rewardScorePoints: 25 });
    const before = await balanceOf(world, world.participantId);

    await awardChallenge(
      world.db,
      {
        eventId: world.eventId,
        challengeId,
        userId: world.participantId,
        awardedBy: world.adminId,
      },
      'award-score-only',
      ctx,
    );

    expect(await balanceOf(world, world.participantId)).toBe(before);
    expect(await scoreOf(world.participantId)).toBe(25);
    expect((await verifyLedgerIntegrity(world.db, world.eventId)).balanced).toBe(true);
  });

  it('a participant with no team still moves the individual board', async () => {
    // otherParticipant is on the same team in the fixture, so use the cashier,
    // who is provisioned as a participant without a team.
    const challengeId = await activeChallenge({ rewardPoints: 0, rewardScorePoints: 15 });

    await awardChallenge(
      world.db,
      {
        eventId: world.eventId,
        challengeId,
        userId: world.cashierId,
        awardedBy: world.adminId,
      },
      'award-no-team',
      ctx,
    );

    expect(await scoreOf(world.cashierId)).toBe(15);
    expect((await verifyLedgerIntegrity(world.db, world.eventId)).balanced).toBe(true);
  });

  it('refuses a draft challenge', async () => {
    const { challengeId } = await createChallenge(
      world.db,
      { eventId: world.eventId, name: 'Draft', slug: 'draft', rewardPoints: 10 },
      ctx,
    );

    await expect(
      awardChallenge(
        world.db,
        {
          eventId: world.eventId,
          challengeId,
          userId: world.participantId,
          awardedBy: world.adminId,
        },
        'award-draft',
        ctx,
      ),
    ).rejects.toThrow(/still a draft/i);
  });

  it('refuses a challenge that has not opened, and one that has closed', async () => {
    const future = await activeChallenge({
      startsAt: new Date(Date.now() + 3_600_000),
    });
    await expect(
      awardChallenge(
        world.db,
        {
          eventId: world.eventId,
          challengeId: future,
          userId: world.participantId,
          awardedBy: world.adminId,
        },
        'award-future',
        ctx,
      ),
    ).rejects.toThrow(/not opened yet/i);

    const past = await activeChallenge({ endsAt: new Date(Date.now() - 1_000) });
    await expect(
      awardChallenge(
        world.db,
        {
          eventId: world.eventId,
          challengeId: past,
          userId: world.participantId,
          awardedBy: world.adminId,
        },
        'award-past',
        ctx,
      ),
    ).rejects.toThrow(/has closed/i);
  });

  it('a challenge from another event reads as missing', async () => {
    const challengeId = await activeChallenge();
    await expect(
      awardChallenge(
        world.db,
        {
          eventId: '00000000-0000-0000-0000-0000000000ff',
          challengeId,
          userId: world.participantId,
          awardedBy: world.adminId,
        },
        'award-wrong-event',
        ctx,
      ),
    ).rejects.toThrow();
  });
});

describe('a challenge cannot pay twice', () => {
  it('refuses a second award of a one-shot challenge', async () => {
    const challengeId = await activeChallenge();
    const award = (key: string) =>
      awardChallenge(
        world.db,
        {
          eventId: world.eventId,
          challengeId,
          userId: world.participantId,
          awardedBy: world.adminId,
        },
        key,
        ctx,
      );

    await award('first');
    await expect(award('second')).rejects.toThrow(/already completed/i);
    expect(await countRows(world.db, 'challenge_completions')).toBe(1);
  });

  it('replaying one idempotency key does not pay again', async () => {
    const challengeId = await activeChallenge();
    const before = await balanceOf(world, world.participantId);

    const first = await awardChallenge(
      world.db,
      {
        eventId: world.eventId,
        challengeId,
        userId: world.participantId,
        awardedBy: world.adminId,
      },
      'same-key',
      ctx,
    );
    const replay = await awardChallenge(
      world.db,
      {
        eventId: world.eventId,
        challengeId,
        userId: world.participantId,
        awardedBy: world.adminId,
      },
      'same-key',
      ctx,
    );

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.result.completionId).toBe(first.result.completionId);
    expect(await balanceOf(world, world.participantId)).toBe(before + 100);
    expect(await countRows(world.db, 'challenge_completions')).toBe(1);
  });

  /**
   * The property the schema's unique index exists for: six staff marking the
   * same one-shot challenge complete at the same instant, each with their own
   * idempotency key, must produce exactly one payout.
   */
  it('six simultaneous awards of a one-shot challenge pay exactly once', async () => {
    const challengeId = await activeChallenge();
    const before = await balanceOf(world, world.participantId);

    const results = await inParallel(
      ['a', 'b', 'c', 'd', 'e', 'f'].map(
        (key) => () =>
          awardChallenge(
            world.db,
            {
              eventId: world.eventId,
              challengeId,
              userId: world.participantId,
              awardedBy: world.adminId,
            },
            `race-${key}`,
            ctx,
          ),
      ),
    );

    expect(countFulfilled(results)).toBe(1);
    expect(await countRows(world.db, 'challenge_completions')).toBe(1);
    expect(await balanceOf(world, world.participantId)).toBe(before + 100);
    expect(await scoreOf(world.participantId)).toBe(0);

    // Every loser failed for the right reason, not on a raw database error.
    for (const code of rejectionCodes(results)) {
      expect(code).toMatch(/challenge_already_completed|conflict/);
    }

    expect((await verifyLedgerIntegrity(world.db, world.eventId)).balanced).toBe(true);
  });

  it('honours a cap above one, then stops', async () => {
    const challengeId = await activeChallenge({ maxCompletionsPerUser: 3, rewardPoints: 10 });
    const before = await balanceOf(world, world.participantId);
    const award = (key: string) =>
      awardChallenge(
        world.db,
        {
          eventId: world.eventId,
          challengeId,
          userId: world.participantId,
          awardedBy: world.adminId,
        },
        key,
        ctx,
      );

    expect((await award('one')).result.completionIndex).toBe(1);
    expect((await award('two')).result.completionIndex).toBe(2);
    expect((await award('three')).result.completionIndex).toBe(3);
    await expect(award('four')).rejects.toThrow(/limit/i);

    expect(await balanceOf(world, world.participantId)).toBe(before + 30);
    expect((await verifyLedgerIntegrity(world.db, world.eventId)).balanced).toBe(true);
  });

  it('the cap is per participant, not per challenge', async () => {
    const challengeId = await activeChallenge({ rewardPoints: 10 });
    const award = (userId: string, key: string) =>
      awardChallenge(
        world.db,
        { eventId: world.eventId, challengeId, userId, awardedBy: world.adminId },
        key,
        ctx,
      );

    await award(world.participantId, 'p1');
    await award(world.otherParticipantId, 'p2');

    expect(await countRows(world.db, 'challenge_completions')).toBe(2);
    const [challenge] = await listChallenges(world.db, world.eventId);
    expect(challenge?.completions).toBe(2);
  });
});
