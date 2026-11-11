import type { MetricsPort, StructuredLoggerPort } from '../ports/observability.ports';
import type {
  ClockPort,
  EventPublisherPort,
  OutboxRepositoryPort,
  UnitOfWorkPort,
} from '../ports/wagering.ports';

export interface OutboxPublisherOptions {
  defaultBatchSize?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

export interface PublishOutboxBatchOptions {
  now?: Date;
  batchSize?: number;
}

export interface PublishOutboxBatchSummary {
  scanned: number;
  published: number;
  failed: number;
}

export interface OutboxPublisherFaultHooks {
  afterSendBeforeMarkPublished?: (outboxId: string) => void | Promise<void>;
}

/**
 * Claims due unpublished outbox events using PostgreSQL FOR UPDATE SKIP LOCKED,
 * publishes them to SQS FIFO with stable eventId deduplication, and marks them
 * published only after SQS confirms delivery.
 */
export class OutboxPublisherUseCase {
  private faultHooks: OutboxPublisherFaultHooks = {};

  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly outboxRepository: OutboxRepositoryPort,
    private readonly eventPublisher: EventPublisherPort,
    private readonly clock: ClockPort,
    private readonly options: OutboxPublisherOptions = {},
    private readonly logger?: StructuredLoggerPort,
    private readonly metrics?: MetricsPort,
  ) {}

  setFaultHooks(hooks: OutboxPublisherFaultHooks): void {
    this.faultHooks = hooks;
  }

  clearFaultHooks(): void {
    this.faultHooks = {};
  }

  async publishDueBatch(
    options: PublishOutboxBatchOptions = {},
  ): Promise<PublishOutboxBatchSummary> {
    const now = options.now ?? this.clock.now();
    const batchSize = options.batchSize ?? this.options.defaultBatchSize ?? 50;
    const baseDelayMs = this.options.baseRetryDelayMs ?? 500;
    const maxDelayMs = this.options.maxRetryDelayMs ?? 30_000;

    return this.unitOfWork.runInTransaction(async (tx) => {
      const dueMessages = await this.outboxRepository.lockDueBatch(tx, now, batchSize);

      let published = 0;
      let failed = 0;

      for (const message of dueMessages) {
        try {
          await this.eventPublisher.publish(message);
          await this.faultHooks.afterSendBeforeMarkPublished?.(message.id);
          message.markPublished(now);
          await this.outboxRepository.save(tx, message);
          published += 1;
        } catch (error) {
          message.scheduleRetry(now, baseDelayMs, maxDelayMs);
          await this.outboxRepository.save(tx, message);
          this.metrics?.recordRetry({ component: 'outbox_publisher' });
          this.logger?.warn('outbox_publish_retry', {
            walletId: message.aggregateId,
            eventId: message.id,
            eventType: message.eventType,
            attempts: message.attempts,
            error: error instanceof Error ? error.message : String(error),
          });
          failed += 1;
        }
      }

      if (published > 0) {
        this.logger?.info('outbox_batch_published', {
          scanned: dueMessages.length,
          published,
          failed,
        });
      }

      return {
        scanned: dueMessages.length,
        published,
        failed,
      };
    });
  }
}
