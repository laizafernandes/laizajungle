import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'wallets' })
export class WalletOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid', fieldName: 'player_id' })
  playerId!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({ type: 'string', columnType: 'numeric(18,2)', fieldName: 'balance_amount' })
  balanceAmount!: string;

  @Property({ type: 'integer', default: 1 })
  version!: number;

  @Property({ type: 'timestamptz', fieldName: 'created_at' })
  createdAt!: Date;

  @Property({ type: 'timestamptz', fieldName: 'updated_at' })
  updatedAt!: Date;
}
