export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expectedCurrency: string, actualCurrency: string) {
    super(`Currency mismatch: expected ${expectedCurrency}, received ${actualCurrency}`);
  }
}

export class InvalidDomainArgumentError extends DomainError {
  readonly code = 'INVALID_DOMAIN_ARGUMENT';

  constructor(message: string) {
    super(message);
  }
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(message: string) {
    super(message);
  }
}

export class InsufficientBalanceError extends DomainError {
  readonly code = 'INSUFFICIENT_BALANCE';

  constructor(walletId: string, balance: string, attemptedDebit: string) {
    super(
      `Insufficient balance on wallet ${walletId}: available ${balance}, attempted debit ${attemptedDebit}`,
    );
  }
}
