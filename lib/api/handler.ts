import { randomUUID } from 'node:crypto';
import type { NextRequest, NextResponse } from 'next/server';
import type { z } from 'zod';
import { buildContext, type RequestContext } from './context';
import { toErrorResponse } from './responses';
import { IdempotencyKeyRequiredError, ValidationError } from '../errors';
import { enforceRateLimit, type RateLimitRule } from '../core/rate-limit';
import type { Permission, Scope } from '../authz/permissions';
import { getDb } from '../db/client';

export interface HandlerOptions<TBody> {
  /** Permission required before the handler body runs. Server-side, always. */
  permission?: Permission;
  /** Derive the authorisation scope (e.g. the store) from the request. */
  scope?: (input: { context: RequestContext; body: TBody; params: Params }) => Scope;
  /** Zod schema for the JSON body. Parsed before the handler sees it. */
  body?: z.ZodType<TBody>;
  /** Require an Idempotency-Key header. Mandatory for money endpoints. */
  idempotent?: boolean;
  rateLimit?: RateLimitRule;
  /** Skip authentication (login, health). Use sparingly and deliberately. */
  public?: boolean;
}

export type Params = Record<string, string>;

export interface HandlerInput<TBody> {
  request: NextRequest;
  context: RequestContext;
  body: TBody;
  params: Params;
  idempotencyKey: string;
}

type RouteContext = { params: Promise<Params> } | undefined;

/**
 * Wrap a route handler with the cross-cutting concerns every endpoint needs.
 *
 * Order matters and is deliberate: authenticate, then verify CSRF and origin,
 * then rate limit, then authorise, then validate, then run. Authorisation
 * happens before the handler body, never inside it, so a route cannot forget.
 */
export function route<TBody = unknown>(
  options: HandlerOptions<TBody>,
  handler: (input: HandlerInput<TBody>) => Promise<NextResponse>,
): (request: NextRequest, routeContext?: RouteContext) => Promise<NextResponse> {
  return async (request, routeContext) => {
    const requestId = request.headers.get('x-request-id') ?? randomUUID();
    const startedAt = Date.now();

    try {
      const params = routeContext ? await routeContext.params : {};

      if (options.public) {
        const body = await parseBody(request, options.body);
        const response = await handler({
          request,
          context: publicContext(requestId),
          body,
          params,
          idempotencyKey: '',
        });
        logRequest(request, response.status, requestId, startedAt);
        return response;
      }

      const context = await buildContext(request);

      if (options.rateLimit) {
        await enforceRateLimit(context.db, options.rateLimit, context.actor.userId);
      }

      const body = await parseBody(request, options.body);

      if (options.permission) {
        const scope = options.scope
          ? options.scope({ context, body, params })
          : { eventId: context.eventId };
        context.actor.require(options.permission, scope);
      }

      let idempotencyKey = '';
      if (options.idempotent) {
        idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? '';
        if (idempotencyKey.length < 8 || idempotencyKey.length > 200) {
          throw new IdempotencyKeyRequiredError();
        }
      }

      const response = await handler({ request, context, body, params, idempotencyKey });
      response.headers.set('x-request-id', context.requestId);
      logRequest(request, response.status, context.requestId, startedAt);
      return response;
    } catch (error) {
      const response = toErrorResponse(error, requestId);
      logRequest(request, response.status, requestId, startedAt);
      return response;
    }
  };
}

async function parseBody<TBody>(
  request: NextRequest,
  schema: z.ZodType<TBody> | undefined,
): Promise<TBody> {
  if (!schema) return undefined as TBody;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError('The request body must be valid JSON.');
  }
  return schema.parse(raw);
}

/** A minimal context for public routes, which have no actor. */
function publicContext(requestId: string): RequestContext {
  return {
    db: getDb(),
    requestId,
    // Public routes must not read `actor`; they are typed to know that.
    actor: null as never,
    sessionId: '',
    eventId: '',
    ipAddress: null,
    userAgent: null,
    audit: { requestId },
  };
}

/**
 * One structured line per request. This is the raw material for latency
 * dashboards and for spotting a terminal that has started failing.
 */
function logRequest(
  request: NextRequest,
  status: number,
  requestId: string,
  startedAt: number,
): void {
  const line = {
    level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
    msg: 'request',
    method: request.method,
    path: new URL(request.url).pathname,
    status,
    durationMs: Date.now() - startedAt,
    requestId,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(line));
}
