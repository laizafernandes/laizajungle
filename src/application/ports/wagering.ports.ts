import type {
  InboxMessage,
  OutboxMessage,
  WagerTransaction,
  WagerTransactionKind,
  Wallet,
  WalletLedgerEntry,
} from '../../domain/index';
import type { LedgerCursor } from '../services/ledger-cursor.codec';

/**
 * Opaque handle representing an active database transaction bound to a Unit of Work.
 */
export interface TransactionContext {
  readonly __brand: 'TransactionContext';
}

export const UNIT_OF_WORK_PORT = Symbol('UNIT_OF_WORK_PORT');
export const WALLET_REPOSITORY_PORT = Symbol('WALLET_REPOSITORY_PORT');
export const WAGER_TRANSACTION_REPOSITORY_PORT = Symbol('WAGER_TRANSACTION_REPOSITORY_PORT');
export const WALLET_LEDGER_REPOSITORY_PORT = Symbol('WALLET_LEDGER_REPOSITORY_PORT');
export const INBOX_REPOSITORY_PORT = Symbol('INBOX_REPOSITORY_PORT');
export const OUTBOX_REPOSITORY_PORT = Symbol('OUTBOX_REPOSITORY_PORT');
export const EVENT_PUBLISHER_PORT = Symbol('EVENT_PUBLISHER_PORT');
export const ID_GENERATOR_PORT = Symbol('ID_GENERATOR_PORT');
export const CLOCK_PORT = Symbol('CLOCK_PORT');
export const PENDING_REFERENCE_POLICY_PORT = Symbol('PENDING_REFERENCE_POLICY_PORT');

export interface PendingReferenceCandidate {
  id: string;
  walletId: string;
}

export interface UnitOfWorkPort {
  runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

export interface WalletRepositoryPort {
  findById(tx: TransactionContext, walletId: string): Promise<Wallet | null>;
  findByIdForUpdate(tx: TransactionContext, walletId: string): Promise<Wallet | null>;
  insert(tx: TransactionContext, wallet: Wallet): Promise<void>;
  save(tx: TransactionContext, wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepositoryPort {
  findById(tx: TransactionContext, transactionId: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(
    tx: TransactionContext,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null>;
  findByProviderExternalId(
    tx: TransactionContext,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  findByIdempotencyOrExternal(
    tx: TransactionContext,
    idempotencyKey: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  findProcessedReversal(
    tx: TransactionContext,
    referenceTransactionId: string,
    kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback,
  ): Promise<WagerTransaction | null>;
  findDuePendingCandidates(now: Date, limit: number): Promise<PendingReferenceCandidate[]>;
  findPendingByIdForUpdate(
    tx: TransactionContext,
    transactionId: string,
  ): Promise<WagerTransaction | null>;
  insert(tx: TransactionContext, transaction: WagerTransaction): Promise<void>;
  save(tx: TransactionContext, transaction: WagerTransaction): Promise<void>;
}

export interface WalletLedgerRepositoryPort {
  insert(tx: TransactionContext, entry: WalletLedgerEntry): Promise<void>;
  findPageByWallet(
    tx: TransactionContext,
    walletId: string,
    limit: number,
    cursor?: LedgerCursor,
  ): Promise<WalletLedgerEntry[]>;
  findAllByWallet(tx: TransactionContext, walletId: string): Promise<WalletLedgerEntry[]>;
}

export interface InboxRepositoryPort {
  findByKey(
    tx: TransactionContext,
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | null>;
  insert(tx: TransactionContext, message: InboxMessage): Promise<void>;
  save(tx: TransactionContext, message: InboxMessage): Promise<void>;
}

export interface OutboxRepositoryPort {
  insert(tx: TransactionContext, message: OutboxMessage): Promise<void>;
  insertMany(tx: TransactionContext, messages: OutboxMessage[]): Promise<void>;
  lockDueBatch(tx: TransactionContext, now: Date, limit: number): Promise<OutboxMessage[]>;
  save(tx: TransactionContext, message: OutboxMessage): Promise<void>;
}

export interface EventPublisherPort {
  publish(message: OutboxMessage): Promise<void>;
}

export interface IdGeneratorPort {
  nextId(): string;
}

export interface ClockPort {
  now(): Date;
}
