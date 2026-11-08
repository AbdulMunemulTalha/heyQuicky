// A failed model call. retryable says whether trying again later may work.
export class AiError extends Error {
  constructor(message, { retryable = false, cause } = {}) {
    super(message, { cause });
    this.retryable = retryable;
  }
}
