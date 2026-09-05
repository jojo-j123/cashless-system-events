import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, type Database } from '../lib/db/client';
import { prepareDatabase } from './helpers';
import { createEvent } from '../lib/services/provisioning';
import { getEventSettings } from '../lib/settings/service';
import {
  EVENT_MODES,
  EVENT_MODE_PRESETS,
  eventModeOf,
  showsStandingsToParticipants,
  type EventMode,
} from '../lib/settings/modes';

const CONTEXT = { actorUserId: null, requestId: 'test' };

let db: Database;
let counter = 0;

beforeEach(async () => {
  db = await prepareDatabase();
});

afterAll(async () => {
  await closeDb();
});

/** A fresh event, so slugs never collide across cases in one file. */
async function eventInMode(mode?: EventMode, settings?: Record<string, unknown>) {
  counter += 1;
  const { eventId } = await createEvent(
    db,
    { slug: `mode-test-${counter}`, name: `Mode Test ${counter}`, mode, ...(settings ? { settings } : {}) },
    CONTEXT,
  );
  return getEventSettings(db, eventId);
}

describe('event modes', () => {
  it('defaults to a normal event when no mode is chosen', async () => {
    const settings = await eventInMode();
    expect(settings.gameModeEnabled).toBe(false);
    expect(eventModeOf(settings)).toBe('STANDARD');
  });

  it('a game event turns the game surface on', async () => {
    const settings = await eventInMode('GAME');
    expect(settings.gameModeEnabled).toBe(true);
    expect(eventModeOf(settings)).toBe('GAME');
  });

  it('a normal event leaves it off', async () => {
    const settings = await eventInMode('STANDARD');
    expect(settings.gameModeEnabled).toBe(false);
    expect(eventModeOf(settings)).toBe('STANDARD');
  });

  it('an explicit setting overrules the mode preset', async () => {
    // Picking GAME and then turning one thing off must not be silently undone
    // by the preset, or the mode stops being a starting point and becomes a cage.
    const settings = await eventInMode('GAME', { gameModeEnabled: false });
    expect(settings.gameModeEnabled).toBe(false);
  });

  it('a mode changes nothing outside the knobs it names', async () => {
    // The whole point: one product, one spine. Choosing a mode must not quietly
    // move a wallet limit or an approval threshold.
    const [standard, game] = [await eventInMode('STANDARD'), await eventInMode('GAME')];
    const { gameModeEnabled: _s, ...standardRest } = standard;
    const { gameModeEnabled: _g, ...gameRest } = game;
    expect(gameRest).toEqual(standardRest);
  });

  it('every mode has a preset', () => {
    for (const mode of EVENT_MODES) {
      expect(EVENT_MODE_PRESETS[mode], `${mode} has no preset`).toBeDefined();
    }
    expect([...EVENT_MODES]).toEqual(['STANDARD', 'GAME']);
  });
});

describe('who sees standings', () => {
  /**
   * The regression this guards: participant surfaces checked only
   * `leaderboardVisibleToParticipants`, so a normal event still showed
   * attendees their team rank.
   */
  it('a normal event shows standings to nobody, however the leaderboard flag is set', () => {
    expect(
      showsStandingsToParticipants({
        gameModeEnabled: false,
        leaderboardVisibleToParticipants: true,
      }),
    ).toBe(false);
    expect(
      showsStandingsToParticipants({
        gameModeEnabled: false,
        leaderboardVisibleToParticipants: false,
      }),
    ).toBe(false);
  });

  it('a game event shows them only when the operator says so', () => {
    expect(
      showsStandingsToParticipants({
        gameModeEnabled: true,
        leaderboardVisibleToParticipants: true,
      }),
    ).toBe(true);
    // Standings kept to staff: the game exists, the players just cannot see it.
    expect(
      showsStandingsToParticipants({
        gameModeEnabled: true,
        leaderboardVisibleToParticipants: false,
      }),
    ).toBe(false);
  });
});
