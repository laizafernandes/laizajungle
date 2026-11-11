import {
  type FailureCode,
  InboxMessage,
  Money,
  type MoneyProps,
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionStatus,
} from '../../domain/index';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  ValidationApplicationError,
  WalletNotFoundError,
} from '../errors/application.error';
import type {
  ClockPort,
  IdGeneratorPort,
  InboxRepositoryPort,
  TransactionContext,
  UnitOfWorkPort,
  WagerTransactionRepositoryPort,
  WalletRepositoryPort,
} from '../ports/wagering.ports';
import { CanonicalPayloadHasher } from '../services/canonical-payload-hasher';
import {
  extractPgUniqueConstraint,
  isNonEmptyString,
  isValidUuid,
} from '../services/validation.helpers';
import type { WagerTransactionResolutionService } from '../services/wager-transaction-resolution.service';

export interface InboxExecutionContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt?: Date;
}

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
  inboxContext?: InboxExecutionContext;
  correlationId?: string;
  causationId?: string;
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
    private readonly resolutionService: WagerTransactionResolutionService,
    private readonly idGenerator: IdGeneratorPort,
    private readonly clock: ClockPort,
    private readonly inboxRepository?: InboxRepositoryPort,
  ) {}

  async execute(command: ProcessWagerTransactionCommand): Promise<ProcessWagerTransactionResult> {
    this.validateCommand(command);
    const money = Money.from(command.money);
    if (!money.isPositive()) {
      throw new ValidationApplicationError('Transaction money amount must be greater than 0.00');
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
        constraint?.includes('uq_wager_tx_provider_external') ||
        constraint?.includes('pk_inbox_messages')
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
    const now = this.clock.now();

    // 0. Inbox deduplication fast-path (when invoked by SQS consumer)
    if (command.inboxContext && this.inboxRepository) {
      const existingInbox = await this.inboxRepository.findByKey(
        tx,
        command.inboxContext.consumerName,
        command.inboxContext.messageId,
      );
      if (existingInbox) {
        if (!existingInbox.matchesPayload(command.inboxContext.payloadHash)) {
          throw new InboxPayloadMismatchError(
            command.inboxContext.consumerName,
            command.inboxContext.messageId,
          );
        }

        const existingTx = await this.wagerTransactionRepository.findByIdempotencyKey(
          tx,
          command.idempotencyKey,
        );
        if (existingTx) {
          return this.buildReplayResult(tx, existingTx, payloadHash);
        }
      }
    }

    // 1. Pre-lock fast-path: replays of already-committed transactions return without waiting on hot-wallet lock.
    const existingPreLock = await this.wagerTransactionRepository.findByIdempotencyKey(
      tx,
      command.idempotencyKey,
    );
    if (existingPreLock) {
      const replay = await this.buildReplayResult(tx, existingPreLock, payloadHash);
      await this.recordInboxProcessedIfPresent(tx, command, now);
      return replay;
    }

    // 2. Acquire per-wallet pessimistic write lock (SELECT ... FOR UPDATE) — Global Lock Order: Wallet -> WagerTransaction.
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
        const replay = await this.buildReplayResult(tx, existingPostLock, payloadHash);
        await this.recordInboxProcessedIfPresent(tx, command, now);
        return replay;
      }
      throw new ExternalTransactionConflictError(command.providerId, command.externalTransactionId);
    }

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

    const outcome = await this.resolutionService.resolveAndApply(
      tx,
      wallet,
      wagerTx,
      now,
      'insert',
      {
        correlationId: command.correlationId ?? command.inboxContext?.messageId ?? wagerTx.id,
        causationId: command.causationId ?? command.inboxContext?.messageId ?? wagerTx.id,
      },
    );

    await this.recordInboxProcessedIfPresent(tx, command, now);

    return {
      ...outcome,
      idempotentReplay: false,
    };
  }

  private async recordInboxProcessedIfPresent(
    tx: TransactionContext,
    command: ProcessWagerTransactionCommand,
    now: Date,
  ): Promise<void> {
    if (!command.inboxContext || !this.inboxRepository) {
      return;
    }

    const inboxMsg = InboxMessage.receive({
      messageId: command.inboxContext.messageId,
      consumerName: command.inboxContext.consumerName,
      payloadHash: command.inboxContext.payloadHash,
      receivedAt: command.inboxContext.receivedAt ?? now,
    });
    inboxMsg.markProcessed(now);
    await this.inboxRepository.insert(tx, inboxMsg);
  }

  private async resolveUniqueConstraintCollision(
    command: ProcessWagerTransactionCommand,
    payloadHash: string,
  ): Promise<ProcessWagerTransactionResult> {
    const maxReads = 5;
    for (let attempt = 0; attempt < maxReads; attempt++) {
      const winner = await this.unitOfWork.runInTransaction(async (tx) => {
        if (command.inboxContext && this.inboxRepository) {
          const existingInbox = await this.inboxRepository.findByKey(
            tx,
            command.inboxContext.consumerName,
            command.inboxContext.messageId,
          );
          if (existingInbox && !existingInbox.matchesPayload(command.inboxContext.payloadHash)) {
            throw new InboxPayloadMismatchError(
              command.inboxContext.consumerName,
              command.inboxContext.messageId,
            );
          }
        }

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
    if (
      (command.kind === WagerTransactionKind.Refund ||
        command.kind === WagerTransactionKind.Rollback) &&
      !isNonEmptyString(command.referenceExternalTransactionId)
    ) {
      throw new ValidationApplicationError(
        `${command.kind} requires referenceExternalTransactionId`,
      );
    }
  }
}
