import type { WagerTransaction, Wallet, WalletLedgerEntry } from '../../domain/index';

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
export const ID_GENERATOR_PORT = Symbol('ID_GENERATOR_PORT');
export const CLOCK_PORT = Symbol('CLOCK_PORT');

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
  insert(tx: TransactionContext, transaction: WagerTransaction): Promise<void>;
}

export interface WalletLedgerRepositoryPort {
  insert(tx: TransactionContext, entry: WalletLedgerEntry): Promise<void>;
}

export interface IdGeneratorPort {
  nextId(): string;
}

export interface ClockPort {
  now(): Date;
}
