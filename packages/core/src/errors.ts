/** Thrown by `createIdempotency` for options that can never work. */
export class IdempotencyConfigError extends Error {
  override readonly name = 'IdempotencyConfigError';
}

/**
 * Thrown by the Express binding's response capture when the connection closes
 * before the handler finishes. The key is released so a retry re-executes.
 */
export class RequestAbortedError extends Error {
  override readonly name = 'RequestAbortedError';
  constructor() {
    super('Request connection closed before the handler finished');
  }
}
