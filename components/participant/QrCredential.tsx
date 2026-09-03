'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { Spinner } from '@/components/ui/primitives';

interface QrResponse {
  token: string;
  /** A real, scannable QR rendered server-side. */
  svg: string;
  expiresAt: string;
  refreshInSeconds: number;
}

/**
 * QR fallback for when NFC is unavailable.
 *
 * The code is short-lived and refreshes itself, so a screenshot shared in a
 * group chat stops working within a couple of minutes. It encodes a public
 * participant reference and a signature — no name, no balance, no id.
 */
export function QrCredential(): React.ReactElement {
  const [qr, setQr] = useState<QrResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const load = async (): Promise<void> => {
      try {
        const response = await api<QrResponse>('/api/qr');
        if (cancelled) return;
        setQr(response);
        setError(null);
        timer = setTimeout(() => void load(), response.refreshInSeconds * 1_000);
      } catch {
        if (!cancelled) setError('Could not load your code. Please try again.');
      }
    };

    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  if (error) return <p className="text-sm text-danger-700">{error}</p>;
  if (!qr) return <Spinner label="Generating your code…" />;

  return (
    <div className="rounded-xl bg-white p-4">
      <div
        className="mx-auto grid place-items-center [&>svg]:h-auto [&>svg]:w-full [&>svg]:max-w-60"
        role="img"
        aria-label="Your event QR code"
        // Server-generated SVG from the qrcode library; no user input reaches it.
        dangerouslySetInnerHTML={{ __html: qr.svg }}
      />
      <p className="mt-3 text-center text-xs text-ink-500">
        Refreshes automatically · expires{' '}
        {new Date(qr.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </p>
    </div>
  );
}
