import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AppError, InternalError, ValidationError, isAppError } from '../errors';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
  requestId: string;
}

export function ok<T>(data: T, init: { status?: number; headers?: HeadersInit } = {}): NextResponse {
  return NextResponse.json(data, { status: init.status ?? 200, headers: init.headers });
}

export function created<T>(data: T, headers?: HeadersInit): NextResponse {
  return NextResponse.json(data, { status: 201, headers });
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

/**
 * Map any thrown value to a response.
 *
 * Known domain errors carry their own status and a message written for the
 * person on the other end. Anything else is a bug: it is logged in full with a
 * correlation id, and the client gets a generic message. Stack traces, SQL and
 * driver details never leave the server.
 */
export function toErrorResponse(error: unknown, requestId: string): NextResponse {
  if (error instanceof ZodError) {
    const validation = new ValidationError('Some of the submitted data is not valid.', {
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return errorBody(validation, requestId);
  }

  if (isAppError(error)) {
    if (error.status >= 500) logUnexpected(error, requestId);
    return errorBody(error, requestId);
  }

  logUnexpected(error, requestId);
  return errorBody(new InternalError(requestId, error), requestId);
}

function errorBody(error: AppError, requestId: string): NextResponse {
  const body: ApiErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
    requestId,
  };

  const headers = new Headers({ 'x-request-id': requestId });
  const retryAfter = error.details?.retryAfterSeconds;
  if (typeof retryAfter === 'number') headers.set('retry-after', String(retryAfter));

  return NextResponse.json(body, { status: error.status, headers });
}

function logUnexpected(error: unknown, requestId: string): void {
  console.error(
    JSON.stringify({
      level: 'error',
      requestId,
      msg: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      timestamp: new Date().toISOString(),
    }),
  );
}

export interface Paginated<T> {
  data: T[];
  nextCursor: string | null;
}
