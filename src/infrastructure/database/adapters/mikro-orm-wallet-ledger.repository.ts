import type { FilterQuery } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';
import type {
  LedgerCursor,
  TransactionContext,
  WalletLedgerRepositoryPort,
} from '../../../application/index';
import type { WalletLedgerEntry } from '../../../domain/index';
import { WalletLedgerEntryOrmEntity } from '../entities/wallet-ledger-entry.orm-entity';
import { WageringMapper } from '../mappers/wagering.mapper';
import { unwrapEntityManager } from './mikro-orm-unit-of-work';

@Injectable()
export class MikroOrmWalletLedgerRepository implements WalletLedgerRepositoryPort {
  async insert(tx: TransactionContext, entry: WalletLedgerEntry): Promise<void> {
    const em = unwrapEntityManager(tx);
    em.persist(WageringMapper.ledgerEntryToOrm(entry));
  }

  async findPageByWallet(
    tx: TransactionContext,
    walletId: string,
    limit: number,
    cursor?: LedgerCursor,
  ): Promise<WalletLedgerEntry[]> {
    const em = unwrapEntityManager(tx);
    const where: FilterQuery<WalletLedgerEntryOrmEntity> = cursor
      ? {
          wallet: walletId,
          $or: [
            { createdAt: { $lt: cursor.createdAt } },
            { createdAt: cursor.createdAt, id: { $lt: cursor.id } },
          ],
        }
      : { wallet: walletId };

    const rows = await em.find(WalletLedgerEntryOrmEntity, where, {
      orderBy: { createdAt: 'DESC', id: 'DESC' },
      limit,
    });

    return rows.map(WageringMapper.ledgerEntryToDomain);
  }

  async findAllByWallet(tx: TransactionContext, walletId: string): Promise<WalletLedgerEntry[]> {
    const em = unwrapEntityManager(tx);
    const rows = await em.find(
      WalletLedgerEntryOrmEntity,
      { wallet: walletId },
      { orderBy: { createdAt: 'ASC', id: 'ASC' } },
    );

    return rows.map(WageringMapper.ledgerEntryToDomain);
  }
}
