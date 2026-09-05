'use client';

import { useCallback, useState } from 'react';
import { api } from '@/lib/client/api';
import { Button } from '@/components/ui/primitives';

/**
 * Sign out, and actually end the session.
 *
 * The endpoint revokes the session server-side rather than only dropping the
 * cookie, so handing a terminal to the next person on shift genuinely ends the
 * last one's access — a cleared cookie alone would leave a live session behind
 * that anyone holding the token could still use.
 *
 * `confirmWhen` guards the till: signing out mid-basket loses the sale, and on
 * a busy counter that button sits a fat finger away from Clear.
 */
export function SignOutButton({
  confirmWhen = false,
  confirmMessage = 'There is an unfinished sale on this screen. Sign out anyway?',
  size = 'sm',
  fullWidth = false,
}: {
  confirmWhen?: boolean;
  confirmMessage?: string;
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);

  const signOut = useCallback(async () => {
    if (confirmWhen && !window.confirm(confirmMessage)) return;
    setBusy(true);
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // The cookie may already be gone or the session already revoked. Either
      // way the intent is to leave, so fall through to the login screen.
    } finally {
      // A hard navigation, not a router push: every cached server component
      // rendered for the previous user has to be dropped.
      window.location.href = '/login';
    }
  }, [confirmMessage, confirmWhen]);

  return (
    <Button
      tone="neutral"
      size={size}
      fullWidth={fullWidth}
      disabled={busy}
      onClick={() => void signOut()}
    >
      {busy ? 'Signing out' : 'Sign out'}
    </Button>
  );
}
