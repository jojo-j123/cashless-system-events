'use client';

/**
 * Browser-side API client.
 *
 * Two things it guarantees that hand-rolled fetch calls would not:
 *  - the CSRF token is attached to every mutation, automatically;
 *  - money requests carry a stable Idempotency-Key that survives retries, so a
 *    dropped connection on a festival wifi never turns into a double charge.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** True when retrying the identical request is safe and might succeed. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429 || this.code === 'request_in_progress';
  }
}

function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)cashless_csrf=([^;]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  eventId?: string;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrfToken();
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  if (options.eventId) headers['x-event-id'] = options.eventId;

  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    if (!response.ok) {
      throw new ApiError(response.status, 'unexpected_response', 'The server returned an error.');
    }
    return (await response.text()) as T;
  }

  const payload = (await response.json()) as
    | T
    | { error: { code: string; message: string; details?: Record<string, unknown> } };

  if (!response.ok) {
    const failure = (payload as { error?: { code: string; message: string; details?: Record<string, unknown> } })
      .error;
    throw new ApiError(
      response.status,
      failure?.code ?? 'unknown_error',
      failure?.message ?? 'Something went wrong.',
      failure?.details,
    );
  }

  return payload as T;
}

/** A fresh idempotency key. Generated once per user intent, reused on retry. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * Retry a money request while preserving its idempotency key.
 *
 * This is the durable-submit path: the request is replayed on transient
 * failures, and because the key is stable the server returns the original
 * result rather than charging again. It is what makes a flaky event network a
 * non-event rather than an incident.
 */
export async function submitWithRetry<T>(
  path: string,
  body: unknown,
  idempotencyKey: string,
  options: { attempts?: number; onAttempt?: (attempt: number) => void } = {},
): Promise<T> {
  const attempts = options.attempts ?? 4;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    options.onAttempt?.(attempt);
    try {
      return await api<T>(path, { method: 'POST', body, idempotencyKey });
    } catch (error) {
      lastError = error;
      const retryable =
        error instanceof ApiError ? error.retryable : error instanceof TypeError; // network failure
      if (!retryable || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2 ** (attempt - 1) * 400));
    }
  }

  throw lastError;
}
