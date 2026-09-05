'use client';

import { useCallback, useState } from 'react';
import type { CardCredential } from '@/lib/nfc/credentials';
import { ApiError, api, newIdempotencyKey } from '@/lib/client/api';
import { useCardReader } from '@/components/nfc/useCardReader';
import { TapPanel } from '@/components/nfc/TapPanel';
import { Alert, Button, Card, Points, Spinner } from '@/components/ui/primitives';

interface TeamOption {
  id: string;
  name: string;
}

interface Enrolled {
  displayName: string;
  participantRef: string;
  cardRef: string;
  teamName: string | null;
  balance: number;
}

const PRESETS = [0, 100, 250, 500, 1000];

/**
 * The registration desk.
 *
 * Name, team, opening balance, tap. The tap is last because it is the only
 * step that involves the person standing in front of you — everything else can
 * be typed while they are still walking up.
 */
export function EnrolDesk({ teams }: { teams: TeamOption[] }): React.ReactElement {
  const [displayName, setDisplayName] = useState('');
  const [teamId, setTeamId] = useState('');
  const [topUpPoints, setTopUpPoints] = useState(500);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Enrolled | null>(null);

  const nameReady = displayName.trim().length >= 2;

  const enrol = useCallback(
    async (credential: CardCredential) => {
      if (!nameReady || busy) return;

      // A tag that already carries a written token identifies itself by that
      // token, not by its serial, so enrolling it here would register a
      // credential the reader will never present.
      if (credential.kind !== 'UID') {
        setError(
          'That tag is already programmed. Assign it from the card list instead of enrolling it here.',
        );
        return;
      }

      setBusy(true);
      setError(null);
      try {
        const result = await api<Enrolled>('/api/cards/enrol', {
          method: 'POST',
          idempotencyKey: newIdempotencyKey(),
          body: {
            displayName: displayName.trim(),
            teamId: teamId || null,
            uid: credential.value,
            topUpPoints,
          },
        });
        setDone(result);
        setDisplayName('');
      } catch (failure) {
        setError(
          failure instanceof ApiError ? failure.message : 'Could not add that card. Try again.',
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, displayName, nameReady, teamId, topUpPoints],
  );

  const onTap = useCallback(
    (credential: CardCredential) => {
      void enrol(credential);
    },
    [enrol],
  );

  const reader = useCardReader(onTap, { enabled: nameReady && !busy && done === null });

  if (done) {
    return (
      <Card className="mx-auto max-w-md text-center">
        <p className="text-sm font-bold uppercase tracking-wide text-success-700">Card added</p>
        <p className="mt-2 text-2xl font-bold text-ink-900">{done.displayName}</p>
        <p className="mt-1 text-sm text-ink-500">
          {done.teamName ? `${done.teamName} · ` : ''}
          {done.participantRef}
        </p>

        <div className="mt-5 rounded-xl bg-ink-50 p-4">
          <p className="tabular text-lg font-semibold text-ink-900">{done.cardRef}</p>
          <p className="mt-2 text-xs uppercase tracking-wide text-ink-500">Balance</p>
          <Points value={done.balance} size="lg" />
        </div>

        <div className="mt-5">
          <Button fullWidth size="lg" onClick={() => setDone(null)}>
            Add another
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      {error ? (
        <Alert tone="danger" title="Not added">
          {error}
        </Alert>
      ) : null}

      <Card className="space-y-4">
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-ink-700">
            Name
          </label>
          <input
            id="name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            autoComplete="off"
            className="mt-1 w-full rounded-xl border border-ink-300 px-4 py-2.5"
          />
        </div>

        <div>
          <label htmlFor="team" className="block text-sm font-medium text-ink-700">
            Team
          </label>
          <select
            id="team"
            value={teamId}
            onChange={(event) => setTeamId(event.target.value)}
            className="mt-1 w-full rounded-xl border border-ink-300 px-4 py-2.5"
          >
            <option value="">No team</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="amount" className="block text-sm font-medium text-ink-700">
            Opening balance
          </label>
          <div className="mt-1 flex flex-wrap gap-2">
            {PRESETS.map((preset) => (
              <Button
                key={preset}
                size="sm"
                tone={topUpPoints === preset ? 'brand' : 'neutral'}
                onClick={() => setTopUpPoints(preset)}
              >
                {preset === 0 ? 'Empty' : preset.toLocaleString()}
              </Button>
            ))}
          </div>
          <input
            id="amount"
            type="number"
            min={0}
            value={topUpPoints}
            onChange={(event) => setTopUpPoints(Math.max(0, Number(event.target.value)))}
            className="tabular mt-2 w-full rounded-xl border border-ink-300 px-4 py-2.5"
          />
        </div>
      </Card>

      {busy ? (
        <Card className="flex justify-center py-10">
          <Spinner label="Adding the card" />
        </Card>
      ) : nameReady ? (
        <TapPanel reader={reader} onManualEntry={onTap} busy={false} />
      ) : (
        <Card className="py-10 text-center text-sm text-ink-500">
          Enter a name, then tap the tag.
        </Card>
      )}
    </div>
  );
}
