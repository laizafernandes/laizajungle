import { afterEach, describe, expect, it } from 'bun:test';
import {
  OutboxPublisherUseCase,
  type OutboxPublisherUseCase as OutboxPublisherUseCaseType,
} from '../../src/application/use-cases/outbox-publisher.use-case';
import { SqsWagerConsumerService } from '../../src/presentation/sqs/sqs-wager-consumer.service';

describe('setFaultHooks — guarda contra uso em produção', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      Reflect.deleteProperty(process.env, 'NODE_ENV');
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  function createOutboxPublisher(): OutboxPublisherUseCaseType {
    return new OutboxPublisherUseCase({} as never, {} as never, {} as never, {
      now: () => new Date(),
    });
  }

  function createSqsConsumer(): SqsWagerConsumerService {
    return new SqsWagerConsumerService({} as never, {} as never);
  }

  it('lança erro quando NODE_ENV === "production" em OutboxPublisherUseCase.setFaultHooks', () => {
    process.env.NODE_ENV = 'production';
    const publisher = createOutboxPublisher();
    expect(() =>
      publisher.setFaultHooks({ afterSendBeforeMarkPublished: () => undefined }),
    ).toThrow();
  });

  it('lança erro quando NODE_ENV === "production" em SqsWagerConsumerService.setFaultHooks', () => {
    process.env.NODE_ENV = 'production';
    const consumer = createSqsConsumer();
    expect(() => consumer.setFaultHooks({ afterCommitBeforeAck: () => undefined })).toThrow();
  });

  it('permite configurar fault hooks quando NODE_ENV !== "production"', () => {
    process.env.NODE_ENV = 'test';
    const publisher = createOutboxPublisher();
    const consumer = createSqsConsumer();

    expect(() =>
      publisher.setFaultHooks({ afterSendBeforeMarkPublished: () => undefined }),
    ).not.toThrow();
    expect(() => consumer.setFaultHooks({ afterCommitBeforeAck: () => undefined })).not.toThrow();
  });
});
