'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, api } from '@/lib/client/api';
import { Alert, Button, Card } from '@/components/ui/primitives';

export function LoginForm(): React.ReactElement {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api('/api/auth/login', { method: 'POST', body: { email, password } });
      router.push('/');
      router.refresh();
    } catch (loginError) {
      setError(
        loginError instanceof ApiError ? loginError.message : 'Sign in failed. Please try again.',
      );
      setBusy(false);
    }
  };

  return (
    <Card>
      <form onSubmit={(event) => void submit(event)} className="space-y-4">
        {error ? <Alert tone="danger" title={error} /> : null}

        <div>
          <label htmlFor="email" className="block text-sm font-medium text-ink-700">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 w-full rounded-xl border border-ink-300 px-4 py-2.5
              focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </div>

        <div>
          <label htmlFor="password" className="block text-sm font-medium text-ink-700">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 w-full rounded-xl border border-ink-300 px-4 py-2.5
              focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </div>

        <Button type="submit" fullWidth size="lg" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </Card>
  );
}
