import type { EventSettings, EventSettingsPatch } from './schema';

/**
 * An event runs in one of two modes.
 *
 * A mode is deliberately *not* a fork in the product. The wallet, the till, the
 * ledger and the cards are byte-for-byte the same either way; `GAME` only ever
 * adds a surface — teams, standings, scores — on top of that same spine. Two
 * codepaths would mean every feature shipped from here on has to answer "but
 * does it work in the other mode?", and that question is paid for at every
 * event, forever.
 *
 * So a mode is a named preset over settings that already exist, and the mode an
 * event is in is *derived* from those settings rather than stored beside them —
 * two copies of one fact can disagree, and this one decides what participants
 * can see.
 */
export const EVENT_MODES = ['STANDARD', 'GAME'] as const;
export type EventMode = (typeof EVENT_MODES)[number];

export const EVENT_MODE_LABELS: Record<EventMode, string> = {
  STANDARD: 'Normal event',
  GAME: 'Game',
};

export const EVENT_MODE_DESCRIPTIONS: Record<EventMode, string> = {
  STANDARD: 'A cashless event: wallets, top-ups and tills. No teams, no scores.',
  GAME: 'Everything a normal event has, plus teams, standings and scoring.',
};

/**
 * The settings a mode fixes when an event is created.
 *
 * Only the knobs the mode actually decides belong here. Everything else stays
 * the operator's choice, and an explicit setting passed alongside a mode wins
 * over the preset.
 */
export const EVENT_MODE_PRESETS: Record<EventMode, EventSettingsPatch> = {
  STANDARD: { gameModeEnabled: false },
  GAME: { gameModeEnabled: true },
};

/** The mode an event is in. Derived, never stored. */
export function eventModeOf(settings: Pick<EventSettings, 'gameModeEnabled'>): EventMode {
  return settings.gameModeEnabled ? 'GAME' : 'STANDARD';
}

/**
 * Whether a participant should be shown standings.
 *
 * These are two different questions, and the bug this exists to prevent was
 * answering only the second: `gameModeEnabled` asks whether the event has a
 * game at all, while `leaderboardVisibleToParticipants` asks whether a game's
 * standings are for players or staff only. A surface that checks just the
 * latter shows team ranks at events that are not running a game.
 *
 * It lives here so the next participant-facing surface inherits the rule
 * instead of re-deriving half of it.
 */
export function showsStandingsToParticipants(
  settings: Pick<EventSettings, 'gameModeEnabled' | 'leaderboardVisibleToParticipants'>,
): boolean {
  return settings.gameModeEnabled && settings.leaderboardVisibleToParticipants;
}
