/**
 * Typed domain errors.
 *
 * Every failure a client can legitimately hit is one of these. They carry a
 * stable machine `code`, an HTTP status, and a message written to be read by a
 * cashier under time pressure — not by a developer.
 *
 * Anything that is NOT one of these is a bug: it is logged with a correlation
 * id and returned as a generic 500. Stack traces and SQL never reach a client.
 */
export type ErrorDetails = Record<string, unknown>;

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: ErrorDetails | undefined;
  /** True when the caller can retry the identical request and it may succeed. */
  readonly retryable: boolean;

  constructor(
    code: string,
    status: number,
    message: string,
    options: { details?: ErrorDetails; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }

  toJSON(): { code: string; message: string; details?: ErrorDetails } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

/* -------------------------------------------------------------------------- */
/* Request / auth                                                             */
/* -------------------------------------------------------------------------- */

export class ValidationError extends AppError {
  constructor(message = 'The submitted data is not valid.', details?: ErrorDetails) {
    super('validation_failed', 422, message, { details });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'You need to sign in to do that.') {
    super('unauthenticated', 401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do that.', details?: ErrorDetails) {
    super('forbidden', 403, message, { details });
  }
}

export class NotFoundError extends AppError {
  constructor(what = 'The requested item', details?: ErrorDetails) {
    super('not_found', 404, `${what} could not be found.`, { details });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'conflict', details?: ErrorDetails) {
    super(code, 409, message, { details });
  }
}

export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds: number, message = 'Too many attempts. Please wait a moment.') {
    super('rate_limited', 429, message, { details: { retryAfterSeconds }, retryable: true });
  }
}

/* -------------------------------------------------------------------------- */
/* Idempotency                                                                */
/* -------------------------------------------------------------------------- */

export class IdempotencyKeyRequiredError extends AppError {
  constructor() {
    super(
      'idempotency_key_required',
      400,
      'This request must include an Idempotency-Key header.',
    );
  }
}

export class IdempotencyConflictError extends AppError {
  constructor() {
    super(
      'idempotency_key_reused',
      409,
      'This idempotency key was already used for a different request.',
    );
  }
}

export class RequestInProgressError extends AppError {
  constructor() {
    super('request_in_progress', 409, 'This request is already being processed.', {
      retryable: true,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Cards                                                                      */
/* -------------------------------------------------------------------------- */

export class CardNotFoundError extends AppError {
  constructor() {
    super('card_not_found', 404, 'This card is not recognised.');
  }
}

export class CardNotAssignedError extends AppError {
  constructor() {
    super('card_not_assigned', 409, 'This card is not linked to an account yet.');
  }
}

export class CardNotUsableError extends AppError {
  constructor(status: string, message: string) {
    super('card_not_usable', 409, message, { details: { status } });
  }
}

/* -------------------------------------------------------------------------- */
/* Wallet                                                                     */
/* -------------------------------------------------------------------------- */

export class InsufficientFundsError extends AppError {
  constructor(balance: number, required: number) {
    super(
      'insufficient_points',
      409,
      `Insufficient points. Balance is ${balance.toLocaleString()}, this costs ${required.toLocaleString()}.`,
      { details: { balance, required, shortfall: required - balance } },
    );
  }
}

export class WalletFrozenError extends AppError {
  constructor() {
    super('wallet_frozen', 409, 'This wallet is frozen and cannot be used.');
  }
}

export class LimitExceededError extends AppError {
  constructor(limitName: string, limit: number, attempted: number, message: string) {
    super('limit_exceeded', 422, message, { details: { limitName, limit, attempted } });
  }
}

/* -------------------------------------------------------------------------- */
/* Inventory & purchases                                                      */
/* -------------------------------------------------------------------------- */

export class OutOfStockError extends AppError {
  constructor(productName: string, available: number, requested: number) {
    super(
      'out_of_stock',
      409,
      available === 0
        ? `${productName} is out of stock.`
        : `Only ${available} × ${productName} left, but ${requested} were requested.`,
      { details: { productName, available, requested } },
    );
  }
}

export class ProductUnavailableError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super('product_unavailable', 409, message, { details });
  }
}

export class StoreClosedError extends AppError {
  constructor(storeName: string) {
    super('store_closed', 409, `${storeName} is currently closed.`);
  }
}

export class RefundNotAllowedError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super('refund_not_allowed', 409, message, { details });
  }
}

/* -------------------------------------------------------------------------- */
/* Event lifecycle                                                            */
/* -------------------------------------------------------------------------- */

export class EventNotOperationalError extends AppError {
  constructor(status: string, action: string) {
    super(
      'event_not_operational',
      409,
      `The event is ${status.toLowerCase()}; ${action} is not available.`,
      { details: { status } },
    );
  }
}

export class FeatureDisabledError extends AppError {
  constructor(feature: string, message: string) {
    super('feature_disabled', 409, message, { details: { feature } });
  }
}

export class ApprovalRequiredError extends AppError {
  constructor(approvalRequestId: string, threshold: number) {
    super(
      'approval_required',
      202,
      'This amount needs a second approver. The request has been submitted.',
      { details: { approvalRequestId, threshold } },
    );
  }
}

/** Not an AppError subclass consumers should catch — the generic fallback. */
export class InternalError extends AppError {
  constructor(correlationId: string, cause?: unknown) {
    super('internal_error', 500, 'Something went wrong. No points were changed.', {
      details: { correlationId },
      cause,
    });
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
