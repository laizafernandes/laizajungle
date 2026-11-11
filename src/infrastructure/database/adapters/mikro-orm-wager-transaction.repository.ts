import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type {
  PendingReferenceCandidate,
  TransactionContext,
  WagerTransactionRepositoryPort,
} from '../../../application/index';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/index';
import { WagerTransactionOrmEntity } from '../entities/wager-transaction.orm-entity';
import { WageringMapper } from '../mappers/wagering.mapper';
import { unwrapEntityManager } from './mikro-orm-unit-of-work';

@Injectable()
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepositoryPort {
  constructor(private readonly rootEm: EntityManager) {}

  async findById(tx: TransactionContext, transactionId: string): Promise<WagerTransaction | null> {
    const em = unwrapEntityManager(tx);
    const orm = await em.findOne(WagerTransactionOrmEntity, { id: transactionId });
    return orm ? WageringMapper.transactionToDomain(orm) : null;
  }

  async findByIdempotencyKey(
    tx: TransactionContext,
    idempotencyKey: string,
  ): Promise<WagerTransaction | null> {
    const em = unwrapEntityManager(tx);
    const orm = await em.findOne(WagerTransactionOrmEntity, { idempotencyKey });
    return orm ? WageringMapper.transactionToDomain(orm) : null;
  }

  async findByProviderExternalId(
    tx: TransactionContext,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const em = unwrapEntityManager(tx);
    const orm = await em.findOne(WagerTransactionOrmEntity, {
      providerId,
      externalTransactionId,
    });
    return orm ? WageringMapper.transactionToDomain(orm) : null;
  }

  async findByIdempotencyOrExternal(
    tx: TransactionContext,
    idempotencyKey: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    const em = unwrapEntityManager(tx);
    const orm = await em.findOne(WagerTransactionOrmEntity, {
      $or: [{ idempotencyKey }, { providerId, externalTransactionId }],
    });
    return orm ? WageringMapper.transactionToDomain(orm) : null;
  }

  async findProcessedReversal(
    tx: TransactionContext,
    referenceTransactionId: string,
    kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback,
  ): Promise<WagerTransaction | null> {
    const em = unwrapEntityManager(tx);
    const orm = await em.findOne(WagerTransactionOrmEntity, {
      referenceTransaction: referenceTransactionId,
      kind,
      status: WagerTransactionStatus.Processed,
    });
    return orm ? WageringMapper.transactionToDomain(orm) : null;
  }

  async findDuePendingCandidates(now: Date, limit: number): Promise<PendingReferenceCandidate[]> {
    const forkedEm = this.rootEm.fork();
    const rows = await forkedEm.execute<Array<{ id: string; wallet_id: string }>>(
      `SELECT id, wallet_id
       FROM wager_transactions
       WHERE status = 'PENDING_REFERENCE'
         AND (next_reference_retry_at IS NULL OR next_reference_retry_at <= ?)
       ORDER BY created_at ASC
       LIMIT ?`,
      [now, limit],
    );

    return rows.map((row) => ({
      id: row.id,
      walletId: row.wallet_id,
    }));
  }

  async findPendingByIdForUpdate(
    tx: TransactionContext,
    transactionId: string,
  ): Promise<WagerTransaction | null> {
    const em = unwrapEntityManager(tx);
    const locked = await em.execute<Array<{ id: string }>>(
      `SELECT id
       FROM wager_transactions
       WHERE id = ?
         AND status = 'PENDING_REFERENCE'
       FOR UPDATE SKIP LOCKED`,
      [transactionId],
    );

    if (locked.length === 0) {
      return null;
    }

    const orm = await em.findOne(WagerTransactionOrmEntity, { id: transactionId });
    return orm ? WageringMapper.transactionToDomain(orm) : null;
  }

  async insert(tx: TransactionContext, transaction: WagerTransaction): Promise<void> {
    const em = unwrapEntityManager(tx);
    em.persist(WageringMapper.transactionToOrm(transaction));
  }

  async save(tx: TransactionContext, transaction: WagerTransaction): Promise<void> {
    const em = unwrapEntityManager(tx);
    const existing = await em.findOneOrFail(WagerTransactionOrmEntity, { id: transaction.id });
    WageringMapper.transactionToOrm(transaction, existing);
  }
}
