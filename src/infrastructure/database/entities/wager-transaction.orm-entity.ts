import { Entity, ManyToOne, PrimaryKey, Property, type Ref } from '@mikro-orm/core';
import type {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/enums/wagering.enums';
import { WalletOrmEntity } from './wallet.orm-entity';

@Entity({ tableName: 'wager_transactions' })
export class WagerTransactionOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 100, fieldName: 'provider_id' })
  providerId!: string;

  @Property({ type: 'string', length: 255, fieldName: 'external_transaction_id' })
  externalTransactionId!: string;

  @Property({ type: 'string', length: 255, fieldName: 'idempotency_key' })
  idempotencyKey!: string;

  @Property({ type: 'string', length: 64, fieldName: 'payload_hash' })
  payloadHash!: string;

  @ManyToOne(() => WalletOrmEntity, { fieldName: 'wallet_id', ref: true })
  wallet!: Ref<WalletOrmEntity>;

  @Property({ type: 'uuid', fieldName: 'player_id' })
  playerId!: string;

  @Property({ type: 'string', length: 255, fieldName: 'round_id' })
  roundId!: string;

  @Property({ type: 'string', length: 255, fieldName: 'game_id' })
  gameId!: string;

  @Property({ type: 'string', length: 20 })
  kind!: WagerTransactionKind;

  @Property({ type: 'string', columnType: 'numeric(18,2)' })
  amount!: string;

  @Property({ type: 'string', length: 3 })
  currency!: string;

  @Property({
    type: 'string',
    length: 255,
    nullable: true,
    fieldName: 'reference_external_transaction_id',
  })
  referenceExternalTransactionId: string | null = null;

  @ManyToOne(() => WagerTransactionOrmEntity, {
    fieldName: 'reference_transaction_id',
    nullable: true,
    ref: true,
  })
  referenceTransaction: Ref<WagerTransactionOrmEntity> | null = null;

  @Property({ type: 'string', length: 30 })
  status!: WagerTransactionStatus;

  @Property({ type: 'string', length: 64, nullable: true, fieldName: 'failure_code' })
  failureCode: FailureCode | null = null;

  @Property({
    type: 'string',
    columnType: 'numeric(18,2)',
    nullable: true,
    fieldName: 'resulting_balance_amount',
  })
  resultingBalanceAmount: string | null = null;

  @Property({ type: 'integer', default: 0, fieldName: 'reference_attempts' })
  referenceAttempts = 0;

  @Property({ type: 'timestamptz', nullable: true, fieldName: 'next_reference_retry_at' })
  nextReferenceRetryAt: Date | null = null;

  @Property({ type: 'timestamptz', fieldName: 'created_at' })
  createdAt!: Date;

  @Property({ type: 'timestamptz', nullable: true, fieldName: 'processed_at' })
  processedAt: Date | null = null;
}
