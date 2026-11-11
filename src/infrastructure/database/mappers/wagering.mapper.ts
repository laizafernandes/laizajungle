import { Reference } from '@mikro-orm/core';
import { Money, WagerTransaction, Wallet, WalletLedgerEntry } from '../../../domain/index';
import { WagerTransactionOrmEntity } from '../entities/wager-transaction.orm-entity';
import { WalletLedgerEntryOrmEntity } from '../entities/wallet-ledger-entry.orm-entity';
import { WalletOrmEntity } from '../entities/wallet.orm-entity';

export class WageringMapper {
  static walletToDomain(orm: WalletOrmEntity): Wallet {
    return Wallet.rehydrate({
      id: orm.id,
      playerId: orm.playerId,
      currency: orm.currency,
      balance: Money.rehydrate({ amount: orm.balanceAmount, currency: orm.currency }),
      version: orm.version,
      createdAt: orm.createdAt,
      updatedAt: orm.updatedAt,
    });
  }

  static walletToOrm(domain: Wallet, target?: WalletOrmEntity): WalletOrmEntity {
    const orm = target ?? new WalletOrmEntity();
    orm.id = domain.id;
    orm.playerId = domain.playerId;
    orm.currency = domain.currency;
    orm.balanceAmount = domain.balance.amount;
    orm.version = domain.version;
    orm.createdAt = domain.createdAt;
    orm.updatedAt = domain.updatedAt;
    return orm;
  }

  static transactionToDomain(orm: WagerTransactionOrmEntity): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: orm.id,
      providerId: orm.providerId,
      externalTransactionId: orm.externalTransactionId,
      idempotencyKey: orm.idempotencyKey,
      payloadHash: orm.payloadHash,
      walletId: orm.wallet.id,
      playerId: orm.playerId,
      roundId: orm.roundId,
      gameId: orm.gameId,
      kind: orm.kind,
      money: Money.rehydrate({ amount: orm.amount, currency: orm.currency }),
      referenceExternalTransactionId: orm.referenceExternalTransactionId ?? undefined,
      createdAt: orm.createdAt,
      status: orm.status,
      referenceTransactionId: orm.referenceTransaction?.id ?? undefined,
      failureCode: orm.failureCode ?? undefined,
      processedAt: orm.processedAt ?? undefined,
      resultingBalance:
        orm.resultingBalanceAmount !== null
          ? Money.rehydrate({ amount: orm.resultingBalanceAmount, currency: orm.currency })
          : undefined,
      referenceAttempts: orm.referenceAttempts,
      nextReferenceRetryAt: orm.nextReferenceRetryAt ?? undefined,
    });
  }

  static transactionToOrm(
    domain: WagerTransaction,
    target?: WagerTransactionOrmEntity,
  ): WagerTransactionOrmEntity {
    const orm = target ?? new WagerTransactionOrmEntity();
    orm.id = domain.id;
    orm.providerId = domain.providerId;
    orm.externalTransactionId = domain.externalTransactionId;
    orm.idempotencyKey = domain.idempotencyKey;
    orm.payloadHash = domain.payloadHash;
    orm.wallet = Reference.createFromPK(WalletOrmEntity, domain.walletId);
    orm.playerId = domain.playerId;
    orm.roundId = domain.roundId;
    orm.gameId = domain.gameId;
    orm.kind = domain.kind;
    orm.amount = domain.money.amount;
    orm.currency = domain.money.currency;
    orm.referenceExternalTransactionId = domain.referenceExternalTransactionId ?? null;
    orm.referenceTransaction = domain.referenceTransactionId
      ? Reference.createFromPK(WagerTransactionOrmEntity, domain.referenceTransactionId)
      : null;
    orm.status = domain.status;
    orm.failureCode = domain.failureCode ?? null;
    orm.resultingBalanceAmount = domain.resultingBalance?.amount ?? null;
    orm.referenceAttempts = domain.referenceAttempts;
    orm.nextReferenceRetryAt = domain.nextReferenceRetryAt ?? null;
    orm.createdAt = domain.createdAt;
    orm.processedAt = domain.processedAt ?? null;
    return orm;
  }

  static ledgerEntryToDomain(orm: WalletLedgerEntryOrmEntity): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: orm.id,
      walletId: orm.wallet.id,
      transactionId: orm.transaction.id,
      direction: orm.direction,
      money: Money.rehydrate({ amount: orm.amount, currency: orm.currency }),
      balanceBefore: Money.rehydrate({ amount: orm.balanceBefore, currency: orm.currency }),
      balanceAfter: Money.rehydrate({ amount: orm.balanceAfter, currency: orm.currency }),
      createdAt: orm.createdAt,
    });
  }

  static ledgerEntryToOrm(domain: WalletLedgerEntry): WalletLedgerEntryOrmEntity {
    const orm = new WalletLedgerEntryOrmEntity();
    orm.id = domain.id;
    orm.wallet = Reference.createFromPK(WalletOrmEntity, domain.walletId);
    orm.transaction = Reference.createFromPK(WagerTransactionOrmEntity, domain.transactionId);
    orm.direction = domain.direction;
    orm.amount = domain.money.amount;
    orm.currency = domain.money.currency;
    orm.balanceBefore = domain.balanceBefore.amount;
    orm.balanceAfter = domain.balanceAfter.amount;
    orm.createdAt = domain.createdAt;
    return orm;
  }
}
