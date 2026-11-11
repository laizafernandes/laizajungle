import type {
  FailureCode,
  LedgerDirection,
  MoneyProps,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/index';
import {
  TransactionNotFoundError,
  ValidationApplicationError,
  WalletNotFoundError,
} from '../errors/application.error';
import type {
  UnitOfWorkPort,
  WagerTransactionRepositoryPort,
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
} from '../ports/wagering.ports';
import { LedgerCursorCodec } from '../services/ledger-cursor.codec';
import { isNonEmptyString, isValidUuid } from '../services/validation.helpers';

export interface WalletDetailsDto {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WalletLedgerItemDto {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface WalletLedgerPageDto {
  items: WalletLedgerItemDto[];
  nextCursor: string | null;
}

export interface WagerTransactionDetailsDto {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: FailureCode | null;
  resultingBalance: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

export class GetWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly walletRepository: WalletRepositoryPort,
  ) {}

  async execute(walletId: string): Promise<WalletDetailsDto> {
    if (!isValidUuid(walletId)) {
      throw new ValidationApplicationError('walletId must be a valid UUID');
    }

    const wallet = await this.unitOfWork.runInTransaction((tx) =>
      this.walletRepository.findById(tx, walletId),
    );
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }
}

export class GetWalletLedgerUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly walletRepository: WalletRepositoryPort,
    private readonly walletLedgerRepository: WalletLedgerRepositoryPort,
  ) {}

  async execute(input: {
    walletId: string;
    cursor?: string;
    limit?: number;
  }): Promise<WalletLedgerPageDto> {
    if (!isValidUuid(input.walletId)) {
      throw new ValidationApplicationError('walletId must be a valid UUID');
    }

    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ValidationApplicationError('limit must be an integer between 1 and 100');
    }

    const decodedCursor =
      input.cursor !== undefined ? LedgerCursorCodec.decode(input.cursor) : undefined;

    return this.unitOfWork.runInTransaction(async (tx) => {
      const wallet = await this.walletRepository.findById(tx, input.walletId);
      if (!wallet) {
        throw new WalletNotFoundError(input.walletId);
      }

      const rows = await this.walletLedgerRepository.findPageByWallet(
        tx,
        input.walletId,
        limit + 1,
        decodedCursor,
      );

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const last = pageRows[pageRows.length - 1];
      const nextCursor =
        hasMore && last
          ? LedgerCursorCodec.encode({ createdAt: last.createdAt, id: last.id })
          : null;

      return {
        items: pageRows.map((entry) => ({
          id: entry.id,
          walletId: entry.walletId,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          createdAt: entry.createdAt.toISOString(),
        })),
        nextCursor,
      };
    });
  }
}

export class GetWagerTransactionUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly wagerTransactionRepository: WagerTransactionRepositoryPort,
  ) {}

  async byId(transactionId: string): Promise<WagerTransactionDetailsDto> {
    if (!isValidUuid(transactionId)) {
      throw new ValidationApplicationError('transactionId must be a valid UUID');
    }

    const txRecord = await this.unitOfWork.runInTransaction((tx) =>
      this.wagerTransactionRepository.findById(tx, transactionId),
    );
    if (!txRecord) {
      throw new TransactionNotFoundError(transactionId);
    }

    return this.toDto(txRecord);
  }

  async byProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionDetailsDto> {
    if (!isNonEmptyString(providerId) || !isNonEmptyString(externalTransactionId)) {
      throw new ValidationApplicationError(
        'providerId and externalTransactionId must be non-empty strings',
      );
    }

    const txRecord = await this.unitOfWork.runInTransaction((tx) =>
      this.wagerTransactionRepository.findByProviderExternalId(
        tx,
        providerId,
        externalTransactionId,
      ),
    );
    if (!txRecord) {
      throw new TransactionNotFoundError(`${providerId}:${externalTransactionId}`);
    }

    return this.toDto(txRecord);
  }

  private toDto(txRecord: WagerTransaction): WagerTransactionDetailsDto {
    return {
      id: txRecord.id,
      providerId: txRecord.providerId,
      externalTransactionId: txRecord.externalTransactionId,
      idempotencyKey: txRecord.idempotencyKey,
      walletId: txRecord.walletId,
      playerId: txRecord.playerId,
      roundId: txRecord.roundId,
      gameId: txRecord.gameId,
      kind: txRecord.kind,
      status: txRecord.status,
      money: txRecord.money.toJSON(),
      referenceExternalTransactionId: txRecord.referenceExternalTransactionId ?? null,
      referenceTransactionId: txRecord.referenceTransactionId ?? null,
      failureCode: txRecord.failureCode ?? null,
      resultingBalance: txRecord.resultingBalance?.toJSON() ?? null,
      createdAt: txRecord.createdAt.toISOString(),
      processedAt: txRecord.processedAt?.toISOString() ?? null,
    };
  }
}
