export abstract class ApplicationError extends Error {
  abstract readonly errorCode: string;

  protected constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationApplicationError extends ApplicationError {
  readonly errorCode = 'INVALID_PAYLOAD';

  constructor(message: string) {
    super(message);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly errorCode = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`Wallet ${walletId} was not found`);
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly errorCode = 'TRANSACTION_NOT_FOUND';

  constructor(identifier: string) {
    super(`Transaction ${identifier} was not found`);
  }
}

export class DuplicateWalletError extends ApplicationError {
  readonly errorCode = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`Wallet already exists for player ${playerId} and currency ${currency}`);
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly errorCode = 'IDEMPOTENCY_CONFLICT';

  constructor(idempotencyKey: string) {
    super(`Idempotency-Key "${idempotencyKey}" was already used with a different payload`);
  }
}

export class ExternalTransactionConflictError extends ApplicationError {
  readonly errorCode = 'EXTERNAL_TRANSACTION_CONFLICT';

  constructor(providerId: string, externalTransactionId: string) {
    super(
      `Transaction (${providerId}, ${externalTransactionId}) already exists under a different Idempotency-Key`,
    );
  }
}

export class TransientInfrastructureError extends ApplicationError {
  readonly errorCode: string = 'TRANSIENT_INFRASTRUCTURE_ERROR';

  constructor(
    message: string,
    public readonly retryAfterSeconds = 1,
  ) {
    super(message);
  }
}

export class WalletLockTimeoutError extends TransientInfrastructureError {
  override readonly errorCode = 'WALLET_LOCK_TIMEOUT';

  constructor(lockTimeoutMs: number, retryAfterSeconds = 1) {
    super(
      `Wallet lock could not be acquired within ${lockTimeoutMs}ms due to concurrent contention; retry safely with the same Idempotency-Key`,
      retryAfterSeconds,
    );
  }
}

export class InboxPayloadMismatchError extends ApplicationError {
  readonly errorCode = 'INBOX_PAYLOAD_MISMATCH';

  constructor(consumerName: string, messageId: string) {
    super(
      `Inbox message (${consumerName}, ${messageId}) already received with a different payloadHash`,
    );
  }
}
