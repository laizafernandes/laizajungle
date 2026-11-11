import { Injectable } from '@nestjs/common';
import type {
  TransactionContext,
  WagerTransactionRepositoryPort,
} from '../../../application/index';
import type { WagerTransaction } from '../../../domain/index';
import { WagerTransactionOrmEntity } from '../entities/wager-transaction.orm-entity';
import { WageringMapper } from '../mappers/wagering.mapper';
import { unwrapEntityManager } from './mikro-orm-unit-of-work';

@Injectable()
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepositoryPort {
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

  async insert(tx: TransactionContext, transaction: WagerTransaction): Promise<void> {
    const em = unwrapEntityManager(tx);
    em.persist(WageringMapper.transactionToOrm(transaction));
  }
}
