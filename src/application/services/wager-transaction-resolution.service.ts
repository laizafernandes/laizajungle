import {
  FailureCode,
  LedgerDirection,
  type MoneyProps,
  OutboxMessage,
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionStatus,
  type Wallet,
  WalletBalanceChanged,
  WalletLedgerEntry,
} from '../../domain/index';
import { ExternalTransactionConflictError } from '../errors/application.error';
import type {
  IdGeneratorPort,
  OutboxRepositoryPort,
  TransactionContext,
  WagerTransactionRepositoryPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
} from '../ports/wagering.ports';
import type { PendingReferencePolicy } from './pending-reference-policy';
import { extractPgUniqueConstraint } from './validation.helpers';

export interface ResolvedExecutionOutcome {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
}

export interface TransactionEventMetadata {
  correlationId?: string;
  causationId?: string;
}

type ReferenceCheckResult =
  | { kind: 'resolved'; reference?: WagerTransaction }
  | { kind: 'missing' }
  | { kind: 'reject'; code: FailureCode };

/**
 * Shared business rule evaluator and transactional state applicator used by both
 * ProcessWagerTransactionUseCase (HTTP/SQS) and ProcessPendingReferencesUseCase (worker).
 */
export class WagerTransactionResolutionService {
  constructor(
    private readonly walletRepository: WalletRepositoryPort,
    private readonly wagerTransactionRepository: WagerTransactionRepositoryPort,
    private readonly walletLedgerRepository: WalletLedgerRepositoryPort,
    private readonly idGenerator: IdGeneratorPort,
    private readonly pendingReferencePolicy: PendingReferencePolicy,
    private readonly outboxRepository?: OutboxRepositoryPort,
  ) {}

  async resolveAndApply(
    tx: TransactionContext,
    wallet: Wallet,
    wagerTx: WagerTransaction,
    now: Date,
    mode: 'insert' | 'update',
    eventMeta?: TransactionEventMetadata,
  ): Promise<ResolvedExecutionOutcome> {
    const basicRejection = this.checkBasicPreconditions(wallet, wagerTx);
    if (basicRejection) {
      wagerTx.reject(basicRejection, now, wallet.balance);
      await this.persistTransaction(tx, wagerTx, mode);
      await this.emitRejectedEvent(
        tx,
        wagerTx,
        basicRejection,
        wallet.balance.toJSON(),
        now,
        eventMeta,
      );
      return this.toOutcome(wagerTx, wallet);
    }

    const refCheck = await this.evaluateReference(tx, wallet, wagerTx);
    if (refCheck.kind === 'missing') {
      return this.handleMissingReference(tx, wallet, wagerTx, now, mode, eventMeta);
    }
    if (refCheck.kind === 'reject') {
      wagerTx.reject(refCheck.code, now, wallet.balance);
      await this.persistTransaction(tx, wagerTx, mode);
      await this.emitRejectedEvent(
        tx,
        wagerTx,
        refCheck.code,
        wallet.balance.toJSON(),
        now,
        eventMeta,
      );
      return this.toOutcome(wagerTx, wallet);
    }

    const referenceTx = refCheck.reference;

    if (!wagerTx.affectsBalance()) {
      wagerTx.markProcessed(referenceTx?.id, now, wallet.balance);
      await this.persistTransaction(tx, wagerTx, mode);
      await this.emitProcessedEvents(tx, wallet, wagerTx, undefined, now, eventMeta);
      return this.toOutcome(wagerTx, wallet);
    }

    const direction = wagerTx.ledgerDirectionFor(referenceTx);
    if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(wagerTx.money)) {
      const code =
        wagerTx.kind === WagerTransactionKind.Bet
          ? FailureCode.InsufficientBalance
          : FailureCode.ReversalNegativeBalance;
      wagerTx.reject(code, now, wallet.balance);
      await this.persistTransaction(tx, wagerTx, mode);
      await this.emitRejectedEvent(tx, wagerTx, code, wallet.balance.toJSON(), now, eventMeta);
      return this.toOutcome(wagerTx, wallet);
    }

    const movement =
      direction === LedgerDirection.Debit
        ? wallet.debit(wagerTx.money, now)
        : wallet.credit(wagerTx.money, now);

    wagerTx.markProcessed(referenceTx?.id, now, movement.balanceAfter);

    const ledgerEntry = WalletLedgerEntry.create({
      id: this.idGenerator.nextId(),
      walletId: wallet.id,
      transactionId: wagerTx.id,
      direction,
      money: wagerTx.money,
      balanceBefore: movement.balanceBefore,
      balanceAfter: movement.balanceAfter,
      createdAt: now,
    });

    await this.walletRepository.save(tx, wallet);
    try {
      await this.persistTransaction(tx, wagerTx, mode);
    } catch (error) {
      const constraint = extractPgUniqueConstraint(error);
      if (constraint?.includes('uq_wager_tx_single_reversal_per_kind')) {
        throw new ExternalTransactionConflictError(
          wagerTx.providerId,
          wagerTx.externalTransactionId,
        );
      }
      throw error;
    }
    await this.walletLedgerRepository.insert(tx, ledgerEntry);
    await this.emitProcessedEvents(tx, wallet, wagerTx, ledgerEntry, now, eventMeta);

    return {
      transactionId: wagerTx.id,
      status: wagerTx.status,
      balance: movement.balanceAfter.toJSON(),
    };
  }

  private checkBasicPreconditions(
    wallet: Wallet,
    wagerTx: WagerTransaction,
  ): FailureCode | undefined {
    if (wallet.currency !== wagerTx.money.currency) {
      return FailureCode.CurrencyMismatch;
    }
    if (wallet.playerId !== wagerTx.playerId) {
      return FailureCode.PlayerMismatch;
    }
    return undefined;
  }

  private async evaluateReference(
    tx: TransactionContext,
    wallet: Wallet,
    wagerTx: WagerTransaction,
  ): Promise<ReferenceCheckResult> {
    const refExtId = wagerTx.referenceExternalTransactionId;
    if (!refExtId) {
      if (wagerTx.requiresReference()) {
        return { kind: 'reject', code: FailureCode.InvalidTransactionRequest };
      }
      return { kind: 'resolved', reference: undefined };
    }

    const ref = await this.wagerTransactionRepository.findByProviderExternalId(
      tx,
      wagerTx.providerId,
      refExtId,
    );

    if (!ref) {
      return { kind: 'missing' };
    }

    // Reference must match provider, player, wallet, currency, and round
    if (
      ref.providerId !== wagerTx.providerId ||
      ref.playerId !== wagerTx.playerId ||
      ref.walletId !== wallet.id ||
      ref.money.currency !== wagerTx.money.currency ||
      ref.roundId !== wagerTx.roundId
    ) {
      return { kind: 'reject', code: FailureCode.ReferenceMismatch };
    }

    // If the referenced transaction itself is still pending its own reference, stay pending
    if (
      ref.status === WagerTransactionStatus.Pending ||
      ref.status === WagerTransactionStatus.PendingReference
    ) {
      return { kind: 'missing' };
    }

    if (ref.status !== WagerTransactionStatus.Processed) {
      return { kind: 'reject', code: FailureCode.ReferenceNotProcessed };
    }

    if (wagerTx.kind === WagerTransactionKind.Win || wagerTx.kind === WagerTransactionKind.Refund) {
      if (ref.kind !== WagerTransactionKind.Bet) {
        return { kind: 'reject', code: FailureCode.InvalidReferenceKind };
      }
    }

    if (wagerTx.kind === WagerTransactionKind.Rollback) {
      const allowedRollbackTargets = new Set<WagerTransactionKind>([
        WagerTransactionKind.Bet,
        WagerTransactionKind.Win,
        WagerTransactionKind.Refund,
      ]);
      if (!allowedRollbackTargets.has(ref.kind)) {
        return { kind: 'reject', code: FailureCode.InvalidReferenceKind };
      }
    }

    if (
      wagerTx.kind === WagerTransactionKind.Refund ||
      wagerTx.kind === WagerTransactionKind.Rollback
    ) {
      if (!wagerTx.money.equals(ref.money)) {
        return { kind: 'reject', code: FailureCode.ReferenceAmountMismatch };
      }

      const existingReversal = await this.wagerTransactionRepository.findProcessedReversal(
        tx,
        ref.id,
        wagerTx.kind,
      );
      if (existingReversal) {
        return { kind: 'reject', code: FailureCode.ReferenceAlreadyReversed };
      }
    }

    return { kind: 'resolved', reference: ref };
  }

  private async handleMissingReference(
    tx: TransactionContext,
    wallet: Wallet,
    wagerTx: WagerTransaction,
    now: Date,
    mode: 'insert' | 'update',
    eventMeta?: TransactionEventMetadata,
  ): Promise<ResolvedExecutionOutcome> {
    if (wagerTx.status === WagerTransactionStatus.Pending) {
      const nextRetryAt = this.pendingReferencePolicy.computeNextRetryAt(0, now);
      wagerTx.markPendingReference(nextRetryAt);
      await this.persistTransaction(tx, wagerTx, mode);
      await this.emitPendingReferenceEvent(tx, wagerTx, nextRetryAt, now, eventMeta);
      return this.toOutcome(wagerTx, wallet);
    }

    const nextAttempts = wagerTx.referenceAttempts + 1;
    if (this.pendingReferencePolicy.isExhausted(nextAttempts, wagerTx.createdAt, now)) {
      // Section 7.1: once retry limit or TTL expires, transition to REJECTED with explicit code
      wagerTx.reject(FailureCode.ReferenceNotFoundExpired, now, wallet.balance);
      await this.persistTransaction(tx, wagerTx, mode);
      await this.emitRejectedEvent(
        tx,
        wagerTx,
        FailureCode.ReferenceNotFoundExpired,
        wallet.balance.toJSON(),
        now,
        eventMeta,
      );
      return this.toOutcome(wagerTx, wallet);
    }

    const nextRetryAt = this.pendingReferencePolicy.computeNextRetryAt(nextAttempts, now);
    wagerTx.scheduleReferenceRetry(nextRetryAt);
    await this.persistTransaction(tx, wagerTx, mode);
    return this.toOutcome(wagerTx, wallet);
  }

  private async emitProcessedEvents(
    tx: TransactionContext,
    wallet: Wallet,
    wagerTx: WagerTransaction,
    ledgerEntry: WalletLedgerEntry | undefined,
    occurredAt: Date,
    eventMeta?: TransactionEventMetadata,
  ): Promise<void> {
    if (!this.outboxRepository) {
      return;
    }

    const correlationId = eventMeta?.correlationId ?? wagerTx.id;
    const causationId = eventMeta?.causationId ?? wagerTx.id;
    const resultingBalance = (wagerTx.resultingBalance ?? wallet.balance).toJSON();

    const outboxMessages = [
      OutboxMessage.enqueue(
        WagerTransactionProcessed.from(wagerTx, resultingBalance, {
          eventId: this.idGenerator.nextId(),
          correlationId,
          causationId,
          occurredAt,
        }),
      ),
    ];

    if (ledgerEntry) {
      outboxMessages.push(
        OutboxMessage.enqueue(
          WalletBalanceChanged.from(wallet, ledgerEntry, {
            eventId: this.idGenerator.nextId(),
            correlationId,
            causationId,
            occurredAt,
          }),
        ),
      );
    }

    await this.outboxRepository.insertMany(tx, outboxMessages);
  }

  private async emitRejectedEvent(
    tx: TransactionContext,
    wagerTx: WagerTransaction,
    failureCode: FailureCode,
    resultingBalance: MoneyProps,
    occurredAt: Date,
    eventMeta?: TransactionEventMetadata,
  ): Promise<void> {
    if (!this.outboxRepository) {
      return;
    }

    const correlationId = eventMeta?.correlationId ?? wagerTx.id;
    const causationId = eventMeta?.causationId ?? wagerTx.id;

    await this.outboxRepository.insert(
      tx,
      OutboxMessage.enqueue(
        WagerTransactionRejected.from(wagerTx, failureCode, resultingBalance, {
          eventId: this.idGenerator.nextId(),
          correlationId,
          causationId,
          occurredAt,
        }),
      ),
    );
  }

  private async emitPendingReferenceEvent(
    tx: TransactionContext,
    wagerTx: WagerTransaction,
    nextRetryAt: Date,
    occurredAt: Date,
    eventMeta?: TransactionEventMetadata,
  ): Promise<void> {
    if (!this.outboxRepository) {
      return;
    }

    const correlationId = eventMeta?.correlationId ?? wagerTx.id;
    const causationId = eventMeta?.causationId ?? wagerTx.id;

    await this.outboxRepository.insert(
      tx,
      OutboxMessage.enqueue(
        WagerTransactionPendingReference.from(wagerTx, nextRetryAt, {
          eventId: this.idGenerator.nextId(),
          correlationId,
          causationId,
          occurredAt,
        }),
      ),
    );
  }

  private async persistTransaction(
    tx: TransactionContext,
    wagerTx: WagerTransaction,
    mode: 'insert' | 'update',
  ): Promise<void> {
    if (mode === 'insert') {
      await this.wagerTransactionRepository.insert(tx, wagerTx);
    } else {
      await this.wagerTransactionRepository.save(tx, wagerTx);
    }
  }

  private toOutcome(wagerTx: WagerTransaction, wallet: Wallet): ResolvedExecutionOutcome {
    return {
      transactionId: wagerTx.id,
      status: wagerTx.status,
      balance: (wagerTx.resultingBalance ?? wallet.balance).toJSON(),
      ...(wagerTx.failureCode ? { failureCode: wagerTx.failureCode } : {}),
    };
  }
}
