import { Entity, ManyToOne, PrimaryKey, Property, type Ref } from '@mikro-orm/core';
import type { LedgerDirection } from '../../../domain/enums/wagering.enums';
import { WagerTransactionOrmEntity } from './wager-transaction.orm-entity';
import { WalletOrmEntity } from './wallet.orm-entity';

@Entity({ tableName: 'wallet_ledger_entries' })
export class WalletLedgerEntryOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne(() => WalletOrmEntity, { fieldName: 'wallet_id', ref: true })
  wallet!: Ref<WalletOrmEntity>;

  @ManyToOne(() => WagerTransactionOrmEntity, { fieldName: 'transaction_id', ref: true })
  transaction!: Ref<WagerTransactionOrmEntity>;

  @Property({ type: 'string', length: 10 })
  direction!: LedgerDirection;

  @Property({ type: 'string', columnType: 'numeric(18,2)' })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: 'string', columnType: 'numeric(18,2)', fieldName: 'balance_before' })
  balanceBefore!: string;

  @Property({ type: 'string', columnType: 'numeric(18,2)', fieldName: 'balance_after' })
  balanceAfter!: string;

  @Property({ type: 'timestamptz', fieldName: 'created_at' })
  createdAt!: Date;
}
