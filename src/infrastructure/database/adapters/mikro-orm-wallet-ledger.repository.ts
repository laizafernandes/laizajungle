import { Injectable } from '@nestjs/common';
import type { TransactionContext, WalletLedgerRepositoryPort } from '../../../application/index';
import type { WalletLedgerEntry } from '../../../domain/index';
import { WageringMapper } from '../mappers/wagering.mapper';
import { unwrapEntityManager } from './mikro-orm-unit-of-work';

@Injectable()
export class MikroOrmWalletLedgerRepository implements WalletLedgerRepositoryPort {
  async insert(tx: TransactionContext, entry: WalletLedgerEntry): Promise<void> {
    const em = unwrapEntityManager(tx);
    em.persist(WageringMapper.ledgerEntryToOrm(entry));
  }
}
