export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

/**
 * Machine-readable failure codes returned to providers and persisted on REJECTED/FAILED transactions.
 * Distinguishes retryable/out-of-order states from permanent business rule rejections.
 */
export enum FailureCode {
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
  ReversalNegativeBalance = 'REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE',
  ReferenceNotFoundExpired = 'REFERENCE_NOT_FOUND_EXPIRED',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PlayerMismatch = 'PLAYER_MISMATCH',
  WalletNotFound = 'WALLET_NOT_FOUND',
  InvalidTransactionRequest = 'INVALID_TRANSACTION_REQUEST',
  InfrastructureFailure = 'INFRASTRUCTURE_FAILURE',
}
