'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CardCredential } from '@/lib/nfc/credentials';
import type { ResolvedCard } from '@/lib/services/cards';
import { ApiError, api, newIdempotencyKey } from '@/lib/client/api';
import { useCardReader } from '@/components/nfc/useCardReader';
import { TapPanel } from '@/components/nfc/TapPanel';
import { Alert, Badge, Button, Card, Points } from '@/components/ui/primitives';

interface TeamOption {
  id: string;
  name: string;
  color: string;
}

interface TopUpRow {
  id: string;
  topupRef: string;
  amountPoints: number;
  reason: string;
  targetType: string;
  createdAt: string;
  recipientName: string | null;
  teamName: string | null;
}

interface ApprovalRow {
  id: string;
  type: string;
  amountPoints: number | null;
  reason: string;
  createdAt: string;
  requesterName: string;
  isOwnRequest: boolean;
}

const QUICK_AMOUNTS = [100, 250, 500, 1_000, 2_500, 5_000];

/**
 * The physical top-up counter plus team allocation and approvals.
 *
 * Tap a card, pick an amount, confirm. Amounts above the configured threshold
 * ask for a staff PIN; above the approval threshold they park for a second
 * person rather than executing.
 */
export function TopUpCounter({
  teams,
  recentTopUps,
  approvals,
  canApprove,
  canAllocate,
  canAdjust,
  settings,
}: {
  teams: TeamOption[];
  recentTopUps: TopUpRow[];
  approvals: ApprovalRow[];
  canApprove: boolean;
  canAllocate: boolean;
  canAdjust: boolean;
  settings: {
    maxSingleTopUp: number;
    pinRequiredAboveTopUp: number;
    approvalThresholdTopUp: number;
  };
}): React.ReactElement {
  const router = useRouter();
  const [customer, setCustomer] = useState<ResolvedCard | null>(null);
  const [amount, setAmount] = useState<number>(500);
  const [reason, setReason] = useState('Counter top-up');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger' | 'warn'; text: string } | null>(
    null,
  );

  const needsPin =
    settings.pinRequiredAboveTopUp > 0 && amount >= settings.pinRequiredAboveTopUp;
  const willNeedApproval =
    settings.approvalThresholdTopUp > 0 && amount >= settings.approvalThresholdTopUp;

  const handleCredential = async (credential: CardCredential): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const resolved = await api<ResolvedCard>('/api/cards/resolve', {
        method: 'POST',
        body: { kind: credential.kind, value: credential.value },
      });
      setCustomer(resolved);
    } catch (error) {
      setMessage({
        tone: 'danger',
        text: error instanceof ApiError ? error.message : 'That card could not be read.',
      });
    } finally {
      setBusy(false);
    }
  };

  const reader = useCardReader(
    (credential) => void handleCredential(credential),
    { enabled: customer === null },
  );

  const submit = async (): Promise<void> => {
    if (!customer || busy) return;
    setBusy(true);
    setMessage(null);

    try {
      const result = await api<{ recipients: { balanceAfter: number }[] }>('/api/wallet/top-up', {
        method: 'POST',
        body: {
          userId: customer.userId,
          amountPoints: amount,
          reason: reason.trim(),
          source: 'POS_COUNTER',
          ...(needsPin ? { pin } : {}),
        },
        idempotencyKey: newIdempotencyKey(),
      });

      setMessage({
        tone: 'success',
        text: `${amount.toLocaleString()} points added. New balance: ${(
          result.recipients[0]?.balanceAfter ?? 0
        ).toLocaleString()}.`,
      });
      setCustomer(null);
      setPin('');
      router.refresh();
    } catch (error) {
      // A parked approval is a normal outcome, not a failure.
      if (error instanceof ApiError && error.code === 'approval_required') {
        setMessage({ tone: 'warn', text: error.message });
        setCustomer(null);
        router.refresh();
      } else {
        setMessage({
          tone: 'danger',
          text: error instanceof ApiError ? error.message : 'The top-up failed. No points were added.',
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const allocate = (): void => {
    const teamId = window.prompt(
      `Allocate to which team? ${teams.map((team) => team.name).join(', ')}`,
    );
    const team = teams.find(
      (entry) => entry.name.toLowerCase() === (teamId ?? '').trim().toLowerCase(),
    );
    if (!team) return;

    const raw = window.prompt('How many points?');
    const points = Number(raw);
    if (!Number.isInteger(points) || points <= 0) return;

    const mode = window.prompt(
      'Mode? TEAM_SCORE (leaderboard only), TEAM_WALLET (shared spendable), SPLIT_EQUALLY_TO_MEMBERS, EACH_MEMBER_FULL_AMOUNT',
      'TEAM_SCORE',
    );
    if (!mode) return;

    const why = window.prompt('Reason?');
    if (!why || why.trim().length < 3) return;

    setBusy(true);
    void api('/api/wallet/top-up/team', {
      method: 'POST',
      body: { teamId: team.id, amountPoints: points, mode: mode.trim(), reason: why.trim() },
      idempotencyKey: newIdempotencyKey(),
    })
      .then(() => {
        setMessage({ tone: 'success', text: `${team.name} allocated ${points.toLocaleString()}.` });
        router.refresh();
      })
      .catch((error: unknown) =>
        setMessage({
          tone: 'danger',
          text: error instanceof ApiError ? error.message : 'The allocation failed.',
        }),
      )
      .finally(() => setBusy(false));
  };

  const decide = (approval: ApprovalRow, decision: 'APPROVED' | 'REJECTED'): void => {
    setBusy(true);
    void api(`/api/approvals/${approval.id}`, {
      method: 'POST',
      body: { decision },
      idempotencyKey: newIdempotencyKey(),
    })
      .then(() => {
        setMessage({ tone: 'success', text: `Request ${decision.toLowerCase()}.` });
        router.refresh();
      })
      .catch((error: unknown) =>
        setMessage({
          tone: 'danger',
          text: error instanceof ApiError ? error.message : 'That decision could not be recorded.',
        }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink-900">Points &amp; top-ups</h1>
          <p className="text-sm text-ink-500">
            Issuing points creates them against the event&rsquo;s issuance account. Every one is
            traceable.
          </p>
        </div>
        {canAllocate ? (
          <Button tone="neutral" onClick={allocate} disabled={busy}>
            Allocate to a team
          </Button>
        ) : null}
      </header>

      {message ? <Alert tone={message.tone} title={message.text} /> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          {customer ? (
            <Card className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xl font-bold text-ink-900">{customer.displayName}</p>
                  <p className="text-sm text-ink-500">
                    {customer.teamName ?? 'No team'} · {customer.cardRef}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs uppercase tracking-wide text-ink-500">Balance</p>
                  <Points value={customer.balance} size="lg" />
                </div>
              </div>

              <div>
                <p className="text-sm font-medium text-ink-700">Amount</p>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {QUICK_AMOUNTS.map((value) => (
                    <Button
                      key={value}
                      tone={amount === value ? 'brand' : 'neutral'}
                      onClick={() => setAmount(value)}
                    >
                      {value.toLocaleString()}
                    </Button>
                  ))}
                </div>
                <input
                  type="number"
                  min={1}
                  max={settings.maxSingleTopUp}
                  value={amount}
                  onChange={(event) => setAmount(Number(event.target.value))}
                  aria-label="Custom amount"
                  className="tabular mt-2 w-full rounded-xl border border-ink-300 px-4 py-3 text-lg"
                />
                <p className="mt-1 text-xs text-ink-500">
                  Maximum {settings.maxSingleTopUp.toLocaleString()} per top-up.
                </p>
              </div>

              <div>
                <label htmlFor="reason" className="text-sm font-medium text-ink-700">
                  Reason
                </label>
                <input
                  id="reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-ink-300 px-4 py-2.5"
                />
              </div>

              {needsPin ? (
                <div>
                  <label htmlFor="pin" className="text-sm font-medium text-ink-700">
                    Staff PIN required for this amount
                  </label>
                  <input
                    id="pin"
                    type="password"
                    inputMode="numeric"
                    value={pin}
                    onChange={(event) => setPin(event.target.value)}
                    className="tabular mt-1 w-full rounded-xl border border-ink-300 px-4 py-2.5 tracking-widest"
                  />
                </div>
              ) : null}

              {willNeedApproval ? (
                <Alert tone="warn" title="This will need a second approver">
                  Amounts of {settings.approvalThresholdTopUp.toLocaleString()} or more are held
                  until another authorised person approves them. No points move until then.
                </Alert>
              ) : null}

              <div className="flex gap-2">
                <Button
                  size="lg"
                  tone="success"
                  fullWidth
                  disabled={busy || amount <= 0 || reason.trim().length < 3}
                  onClick={() => void submit()}
                >
                  {busy ? 'Working…' : `Add ${amount.toLocaleString()} points`}
                </Button>
                <Button size="lg" tone="neutral" onClick={() => setCustomer(null)} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </Card>
          ) : (
            <TapPanel
              reader={reader}
              busy={busy}
              onManualEntry={(credential) => void handleCredential(credential)}
            />
          )}

          {canApprove && approvals.length > 0 ? (
            <Card>
              <h2 className="text-sm font-bold uppercase tracking-wide text-ink-500">
                Awaiting approval
              </h2>
              <ul className="mt-3 divide-y divide-ink-200">
                {approvals.map((approval) => (
                  <li key={approval.id} className="py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-ink-900">
                          {approval.type.replace(/_/g, ' ').toLowerCase()}
                        </p>
                        <p className="text-xs text-ink-500">{approval.reason}</p>
                        <p className="text-xs text-ink-400">
                          Requested by {approval.requesterName} ·{' '}
                          {new Date(approval.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <Points value={approval.amountPoints ?? 0} />
                    </div>
                    {approval.isOwnRequest ? (
                      <p className="mt-2">
                        <Badge tone="warn">You cannot approve your own request</Badge>
                      </p>
                    ) : (
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          tone="success"
                          disabled={busy}
                          onClick={() => decide(approval, 'APPROVED')}
                        >
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          tone="danger"
                          disabled={busy}
                          onClick={() => decide(approval, 'REJECTED')}
                        >
                          Reject
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>

        <Card>
          <h2 className="text-sm font-bold uppercase tracking-wide text-ink-500">Recent top-ups</h2>
          {recentTopUps.length === 0 ? (
            <p className="mt-4 text-sm text-ink-500">Nothing issued yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-ink-200">
              {recentTopUps.map((row) => (
                <li key={row.id} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-800">
                      {row.recipientName ?? row.teamName ?? 'Unknown'}
                    </p>
                    <p className="truncate text-xs text-ink-500">{row.reason}</p>
                    <p className="tabular text-xs text-ink-400">
                      {row.topupRef} · {new Date(row.createdAt).toLocaleTimeString()}
                    </p>
                  </div>
                  <Points value={row.amountPoints} signed />
                </li>
              ))}
            </ul>
          )}
          {canAdjust ? (
            <p className="mt-4 border-t border-ink-200 pt-3 text-xs text-ink-500">
              Manual adjustments are available through the API and are always recorded with a
              reason, the before and after balance, and who made them.
            </p>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
