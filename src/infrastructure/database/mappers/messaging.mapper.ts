import { InboxMessage, OutboxMessage } from '../../../domain/index';
import { InboxMessageOrmEntity } from '../entities/inbox-message.orm-entity';
import { OutboxMessageOrmEntity } from '../entities/outbox-message.orm-entity';

export class MessagingMapper {
  static inboxToDomain(orm: InboxMessageOrmEntity): InboxMessage {
    return InboxMessage.rehydrate({
      messageId: orm.messageId,
      consumerName: orm.consumerName,
      payloadHash: orm.payloadHash,
      receivedAt: orm.receivedAt,
      processedAt: orm.processedAt ?? undefined,
    });
  }

  static inboxToOrm(domain: InboxMessage, target?: InboxMessageOrmEntity): InboxMessageOrmEntity {
    const orm = target ?? new InboxMessageOrmEntity();
    orm.consumerName = domain.consumerName;
    orm.messageId = domain.messageId;
    orm.payloadHash = domain.payloadHash;
    orm.receivedAt = domain.receivedAt;
    orm.processedAt = domain.processedAt ?? null;
    return orm;
  }

  static outboxToDomain(orm: OutboxMessageOrmEntity): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: orm.id,
      aggregateId: orm.aggregateId,
      eventType: orm.eventType,
      payload: orm.payload,
      occurredAt: orm.occurredAt,
      attempts: orm.attempts,
      nextAttemptAt: orm.nextAttemptAt ?? undefined,
      publishedAt: orm.publishedAt ?? undefined,
    });
  }

  static outboxToOrm(
    domain: OutboxMessage,
    target?: OutboxMessageOrmEntity,
  ): OutboxMessageOrmEntity {
    const orm = target ?? new OutboxMessageOrmEntity();
    orm.id = domain.id;
    orm.aggregateId = domain.aggregateId;
    orm.eventType = domain.eventType;
    orm.payload = { ...domain.payload };
    orm.occurredAt = domain.occurredAt;
    orm.attempts = domain.attempts;
    orm.nextAttemptAt = domain.nextAttemptAt ?? null;
    orm.publishedAt = domain.publishedAt ?? null;
    return orm;
  }
}
