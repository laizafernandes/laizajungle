import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { InboxRepositoryPort, TransactionContext } from '../../../application/index';
import type { InboxMessage } from '../../../domain/index';
import { InboxMessageOrmEntity } from '../entities/inbox-message.orm-entity';
import { MessagingMapper } from '../mappers/messaging.mapper';
import { unwrapEntityManager } from './mikro-orm-unit-of-work';

@Injectable()
export class MikroOrmInboxRepository implements InboxRepositoryPort {
  constructor(_rootEm?: EntityManager) {}

  async findByKey(
    tx: TransactionContext,
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | null> {
    const em = unwrapEntityManager(tx);
    const orm = await em.findOne(InboxMessageOrmEntity, { consumerName, messageId });
    return orm ? MessagingMapper.inboxToDomain(orm) : null;
  }

  async insert(tx: TransactionContext, message: InboxMessage): Promise<void> {
    const em = unwrapEntityManager(tx);
    em.persist(MessagingMapper.inboxToOrm(message));
    await em.flush();
  }

  async save(tx: TransactionContext, message: InboxMessage): Promise<void> {
    const em = unwrapEntityManager(tx);
    const existing = await em.findOneOrFail(InboxMessageOrmEntity, {
      consumerName: message.consumerName,
      messageId: message.messageId,
    });
    MessagingMapper.inboxToOrm(message, existing);
    await em.flush();
  }
}
