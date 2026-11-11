import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import type { OutboxRepositoryPort, TransactionContext } from '../../../application/index';
import type { OutboxMessage } from '../../../domain/index';
import { OutboxMessageOrmEntity } from '../entities/outbox-message.orm-entity';
import { MessagingMapper } from '../mappers/messaging.mapper';
import { unwrapEntityManager } from './mikro-orm-unit-of-work';

@Injectable()
export class MikroOrmOutboxRepository implements OutboxRepositoryPort {
  constructor(_rootEm?: EntityManager) {}

  async insert(tx: TransactionContext, message: OutboxMessage): Promise<void> {
    const em = unwrapEntityManager(tx);
    em.persist(MessagingMapper.outboxToOrm(message));
    await em.flush();
  }

  async insertMany(tx: TransactionContext, messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    const em = unwrapEntityManager(tx);
    for (const message of messages) {
      em.persist(MessagingMapper.outboxToOrm(message));
    }
    await em.flush();
  }

  async lockDueBatch(tx: TransactionContext, now: Date, limit: number): Promise<OutboxMessage[]> {
    const em = unwrapEntityManager(tx);
    const locked = await em.execute<Array<{ id: string }>>(
      `SELECT id
       FROM outbox_messages
       WHERE published_at IS NULL
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY occurred_at ASC, id ASC
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );

    if (locked.length === 0) {
      return [];
    }

    const ids = locked.map((row) => row.id);
    const rows = await em.find(
      OutboxMessageOrmEntity,
      { id: { $in: ids } },
      { orderBy: { occurredAt: 'ASC', id: 'ASC' } },
    );

    return rows.map((row) => MessagingMapper.outboxToDomain(row));
  }

  async save(tx: TransactionContext, message: OutboxMessage): Promise<void> {
    const em = unwrapEntityManager(tx);
    const existing = await em.findOneOrFail(OutboxMessageOrmEntity, { id: message.id });
    MessagingMapper.outboxToOrm(message, existing);
    await em.flush();
  }
}
