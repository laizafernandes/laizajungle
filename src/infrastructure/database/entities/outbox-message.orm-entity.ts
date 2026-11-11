import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageOrmEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 255, fieldName: 'aggregate_id' })
  aggregateId!: string;

  @Property({ type: 'string', length: 100, fieldName: 'event_type' })
  eventType!: string;

  @Property({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ type: 'timestamptz', fieldName: 'occurred_at' })
  occurredAt!: Date;

  @Property({ type: 'integer', default: 0 })
  attempts = 0;

  @Property({ type: 'timestamptz', nullable: true, fieldName: 'next_attempt_at' })
  nextAttemptAt: Date | null = null;

  @Property({ type: 'timestamptz', nullable: true, fieldName: 'published_at' })
  publishedAt: Date | null = null;
}
