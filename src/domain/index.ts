export {
  InboxMessage,
  type InboxMessageState,
  type ReceiveInboxProps,
} from './entities/inbox-message';
export { OutboxMessage, type OutboxMessageState } from './entities/outbox-message';
export {
  WagerTransaction,
  type CreateOpeningTransactionProps,
  type CreateWagerTransactionProps,
  type WagerTransactionState,
} from './entities/wager-transaction';
export {
  Wallet,
  type OpenWalletProps,
  type WalletBalanceMovement,
  type WalletState,
} from './entities/wallet';
export {
  WalletLedgerEntry,
  type CreateLedgerEntryProps,
  type LedgerEntryState,
} from './entities/wallet-ledger-entry';
export {
  FailureCode,
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './enums/wagering.enums';
export {
  BalanceLimitExceededError,
  CurrencyMismatchError,
  DomainError,
  InsufficientBalanceError,
  InvalidDomainArgumentError,
  InvalidMoneyError,
  InvalidTransactionStateError,
} from './errors/domain.error';
export {
  IntegrationEvent,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
  type EventContext,
  type IntegrationEventProps,
  type SerializedIntegrationEvent,
  type WagerTransactionPendingReferenceData,
  type WagerTransactionProcessedData,
  type WagerTransactionRejectedData,
  type WalletBalanceChangedData,
} from './events/integration-events';
export { MAX_MONEY_AMOUNT, Money, type MoneyProps } from './value-objects/money';
