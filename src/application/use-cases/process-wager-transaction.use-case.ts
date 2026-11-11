import {
  FailureCode,
  LedgerDirection,
  Money,
  type MoneyProps,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type Wallet,
  WalletLedgerEntry,
} from '../../domain/index';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  ValidationApplicationError,
  WalletNotFoundError,
} from '../errors/application.error';
import type {
  ClockPort,
  IdGeneratorPort,
  TransactionContext,
  UnitOfWorkPort,
  WagerTransactionRepositoryPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
} from '../ports/wagering.ports';
import { CanonicalPayloadHasher } from '../services/canonical-payload-hasher';
import {
  extractPgUniqueConstraint,
  isNonEmptyString,
  isValidUuid,
} from '../services/validation.helpers';

export interface ProcessWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface ProcessWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

const VALID_EXTERNAL_KINDS = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly walletRepository: WalletRepositoryPort,
    private readonly wagerTransactionRepository: WagerTransactionRepositoryPort,
    private readonly walletLedgerRepository: WalletLedgerRepositoryPort,
    private readonly idGenerator: IdGeneratorPort,
    private readonly clock: ClockPort,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    this.validateCommand(command);
    const money = Money.from(command.money);
    if (!money.isPositive()) {
      throw new ValidationApplicationError('Transaction money amount must be greater than 0.00');
    }

    if (
      command.kind === WagerTransactionKind.Refund ||
      command.kind === WagerTransactionKind.Rollback
    ) {
      throw new ValidationApplicationError(
        `Transaction kind ${command.kind} is not enabled yet (scheduled for Sprint 4)`,
      );
    }

    const payloadHash = CanonicalPayloadHasher.hash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: money.toJSON(),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    try {
      return await this.unitOfWork.runInTransaction((tx) =>
        this.processInsideTransaction(tx, command, money, payloadHash),
      );
    } catch (error) {
      const constraint = extractPgUniqueConstraint(error);

      if (
        constraint?.includes('uq_wager_tx_idempotency_key') ||
        constraint?.includes('uq_wager_tx_provider_external')
      ) {
        return this.resolveUniqueConstraintCollision(command, payloadHash);
      }

      throw error;
    }
  }

  private async processInsideTransaction(
    tx: TransactionContext,
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
  ): Promise<ProcessWagerTransactionResult> {
    // 1. Pre-lock fast-path: replays of already-committed transactions return without waiting on hot-wallet lock.
    const existingPreLock = await this.wagerTransactionRepository.findByIdempotencyKey(
      tx,
      command.idempotencyKey,
    );
    if (existingPreLock) {
      return this.buildReplayResult(tx, existingPreLock, payloadHash);
    }

    // 2. Acquire per-wallet pessimistic write lock (SELECT ... FOR UPDATE).
    const wallet = await this.walletRepository.findByIdForUpdate(tx, command.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(command.walletId);
    }

    // 3. Post-lock re-check: if a concurrent request for the same wallet committed while we waited
    //    for the row lock, return replay/conflict immediately without hitting 23505 rollback.
    const existingPostLock = await this.wagerTransactionRepository.findByIdempotencyOrExternal(
      tx,
      command.idempotencyKey,
      command.providerId,
      command.externalTransactionId,
    );
    if (existingPostLock) {
      if (existingPostLock.idempotencyKey === command.idempotencyKey) {
        return this.buildReplayResult(tx, existingPostLock, payloadHash);
      }
      throw new ExternalTransactionConflictError(command.providerId, command.externalTransactionId);
    }

    const now = this.clock.now();
    const wagerTx = WagerTransaction.create({
      id: this.idGenerator.nextId(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: wallet.id,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    const businessRejection = this.checkBusinessPreconditions(wallet, command, money);
    if (businessRejection) {
      wagerTx.reject(businessRejection, now, wallet.balance);
      await this.wagerTransactionRepository.insert(tx, wagerTx);
      return {
        transactionId: wagerTx.id,
        status: WagerTransactionStatus.Rejected,
        failureCode: businessRejection,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    }

    return this.applyTransaction(tx, wallet, wagerTx, now);
  }

  private checkBusinessPreconditions(
    wallet: Wallet,
    command: ProcessWagerTransactionCommand,
    money: Money,
  ): FailureCode | undefined {
    if (wallet.currency !== money.currency) {
      return FailureCode.CurrencyMismatch;
    }
    if (wallet.playerId !== command.playerId) {
      return FailureCode.PlayerMismatch;
    }
    if (command.kind === WagerTransactionKind.Bet && wallet.balance.isLessThan(money)) {
      return FailureCode.InsufficientBalance;
    }
    return undefined;
  }

  private async applyTransaction(
    tx: TransactionContext,
    wallet: Wallet,
    wagerTx: WagerTransaction,
    now: Date,
  ): Promise<ProcessWagerTransactionResult> {
    if (!wagerTx.affectsBalance()) {
      // LOSS: records outcome without altering wallet balance or creating a ledger entry.
      wagerTx.markProcessed(undefined, now, wallet.balance);
      await this.wagerTransactionRepository.insert(tx, wagerTx);
      return {
        transactionId: wagerTx.id,
        status: WagerTransactionStatus.Processed,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
      };
    }

    const direction = wagerTx.ledgerDirectionFor();
    const movement =
      direction === LedgerDirection.Debit
        ? wallet.debit(wagerTx.money, now)
        : wallet.credit(wagerTx.money, now);

    wagerTx.markProcessed(undefined, now, movement.balanceAfter);

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
    await this.wagerTransactionRepository.insert(tx, wagerTx);
    await this.walletLedgerRepository.insert(tx, ledgerEntry);

    return {
      transactionId: wagerTx.id,
      status: WagerTransactionStatus.Processed,
      balance: movement.balanceAfter.toJSON(),
      idempotentReplay: false,
    };
  }

  private async resolveUniqueConstraintCollision(
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
  ): Promise<ProcessWagerTransactionResult> {
    const maxReads = 5;
    for (let attempt = 0; attempt < maxReads; attempt++) {
      const winner = await this.unitOfWork.runInTransaction(async (tx) => {
        const byKey = await this.wagerTransactionRepository.findByIdempotencyKey(
          tx,
          command.idempotencyKey,
        );
        if (byKey) {
          return this.buildReplayResult(tx, byKey, payloadHash);
        }

        const byExternal = await this.wagerTransactionRepository.findByProviderExternalId(
          tx,
          command.providerId,
          command.externalTransactionId,
        );
        if (byExternal) {
          throw new ExternalTransactionConflictError(
            command.providerId,
            command.externalTransactionId,
          );
        }

        return null;
      });

      if (winner) {
        return winner;
      }

      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
    }

    throw new IdempotencyConflictError(command.idempotencyKey);
  }

  private async buildReplayResult(
    tx: TransactionContext,
    existing: WagerTransaction,
    payloadHash: string,
  ): Promise<ProcessWagerTransactionResult> {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(existing.idempotencyKey);
    }

    let observedBalance = existing.resultingBalance;
    if (!observedBalance) {
      const wallet = await this.walletRepository.findById(tx, existing.walletId);
      observedBalance = wallet?.balance ?? Money.zero(existing.money.currency);
    }

    return {
      transactionId: existing.id,
      status: existing.status,
      balance: observedBalance.toJSON(),
      idempotentReplay: true,
      ...(existing.failureCode ? { failureCode: existing.failureCode } : {}),
    };
  }

  private validateCommand(command: ProcessWagerTransactionCommand): void {
    if (!isNonEmptyString(command.idempotencyKey)) {
      throw new ValidationApplicationError('Idempotency-Key header is required');
    }
    if (!isNonEmptyString(command.providerId)) {
      throw new ValidationApplicationError('providerId must be a non-empty string');
    }
    if (!isNonEmptyString(command.externalTransactionId)) {
      throw new ValidationApplicationError('externalTransactionId must be a non-empty string');
    }
    if (!isValidUuid(command.playerId)) {
      throw new ValidationApplicationError('playerId must be a valid UUID');
    }
    if (!isValidUuid(command.walletId)) {
      throw new ValidationApplicationError('walletId must be a valid UUID');
    }
    if (!isNonEmptyString(command.roundId)) {
      throw new ValidationApplicationError('roundId must be a non-empty string');
    }
    if (!isNonEmptyString(command.gameId)) {
      throw new ValidationApplicationError('gameId must be a non-empty string');
    }
    if (command.kind === WagerTransactionKind.Opening) {
      throw new ValidationApplicationError(
        'WagerTransactionKind.Opening is internal and cannot be submitted',
      );
    }
    if (!VALID_EXTERNAL_KINDS.has(command.kind)) {
      throw new ValidationApplicationError(`Invalid transaction kind: ${String(command.kind)}`);
    }
  }
}
