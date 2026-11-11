import { LockMode } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';
import type { TransactionContext, WalletRepositoryPort } from '../../../application/index';
import type { Wallet } from '../../../domain/index';
import { WalletOrmEntity } from '../entities/wallet.orm-entity';
import { WageringMapper } from '../mappers/wagering.mapper';
import { unwrapEntityManager } from './mikro-orm-unit-of-work';

@Injectable()
export class MikroOrmWalletRepository implements WalletRepositoryPort {
  async findById(tx: TransactionContext, walletId: string): Promise<Wallet | null> {
    const em = unwrapEntityManager(tx);
    const orm = await em.findOne(WalletOrmEntity, { id: walletId });
    return orm ? WageringMapper.walletToDomain(orm) : null;
  }

  async findByIdForUpdate(tx: TransactionContext, walletId: string): Promise<Wallet | null> {
    const em = unwrapEntityManager(tx);
    const orm = await em.findOne(
      WalletOrmEntity,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return orm ? WageringMapper.walletToDomain(orm) : null;
  }

  async insert(tx: TransactionContext, wallet: Wallet): Promise<void> {
    const em = unwrapEntityManager(tx);
    em.persist(WageringMapper.walletToOrm(wallet));
  }

  async save(tx: TransactionContext, wallet: Wallet): Promise<void> {
    const em = unwrapEntityManager(tx);
    const existing = await em.findOneOrFail(WalletOrmEntity, { id: wallet.id });
    WageringMapper.walletToOrm(wallet, existing);
  }
}
