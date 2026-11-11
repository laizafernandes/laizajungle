import { Entity, PrimaryKey, PrimaryKeyProp, Property } from '@mikro-orm/core';

@Entity({ tableName: 'inbox_messages' })
export class InboxMessageOrmEntity {
  @PrimaryKey({ type: 'string', length: 120, fieldName: 'consumer_name' })
  consumerName!: string;

  @PrimaryKey({ type: 'string', length: 255, fieldName: 'message_id' })
  messageId!: string;

  [PrimaryKeyProp]?: ['consumerName', 'messageId'];

  @Property({ type: 'string', length: 64, fieldName: 'payload_hash' })
  payloadHash!: string;

  @Property({ type: 'timestamptz', fieldName: 'received_at' })
  receivedAt!: Date;

  @Property({ type: 'timestamptz', nullable: true, fieldName: 'processed_at' })
  processedAt: Date | null = null;
}
