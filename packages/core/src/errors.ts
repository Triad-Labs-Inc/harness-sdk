import type { HarnessErrorData } from "./types.js";

export class HarnessError extends Error {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (details) this.details = details;
  }

  toData(): HarnessErrorData {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}

export class ValidationError extends HarnessError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super("VALIDATION_ERROR", message, details);
  }
}

export class UnsupportedCapabilityError extends HarnessError {
  constructor(capability: string, provider: string) {
    super("UNSUPPORTED_CAPABILITY", `${provider} does not support ${capability}`, {
      capability,
      provider,
    });
  }
}

export class UnsupportedAdapterVersionError extends HarnessError {
  constructor(provider: string, version: unknown) {
    super("UNSUPPORTED_ADAPTER_VERSION", `Unsupported adapter version for ${provider}`, {
      provider,
      version: String(version),
    });
  }
}

export class ProviderUnavailableError extends HarnessError {
  constructor(provider: string, state: string, message: string) {
    super("PROVIDER_UNAVAILABLE", `${provider}: ${message}`, { provider, state });
  }
}

export class SessionNotFoundError extends HarnessError {
  constructor(sessionId: string) {
    super("SESSION_NOT_FOUND", `Session ${sessionId} was not found`, { sessionId });
  }
}

export class SessionDeletedError extends HarnessError {
  constructor(sessionId: string) {
    super("SESSION_DELETED", `Session ${sessionId} was deleted`, { sessionId });
  }
}

export class InteractionNotFoundError extends HarnessError {
  constructor(requestId: string) {
    super("INTERACTION_NOT_FOUND", `Pending interaction ${requestId} was not found`, {
      requestId,
    });
  }
}

export class SlowConsumerError extends HarnessError {
  readonly lastSequence: number;

  constructor(lastSequence: number) {
    super("SLOW_CONSUMER", "Subscriber could not keep up with the event stream", {
      lastSequence,
    });
    this.lastSequence = lastSequence;
  }
}

export class HarnessClosedError extends HarnessError {
  constructor() {
    super("HARNESS_CLOSED", "Harness is closed");
  }
}

export class StorageError extends HarnessError {
  override readonly cause: unknown;

  constructor(operation: string, cause: unknown) {
    super("STORE_WRITE_FAILED", `Harness storage operation failed: ${operation}`, { operation });
    this.cause = cause;
  }
}
