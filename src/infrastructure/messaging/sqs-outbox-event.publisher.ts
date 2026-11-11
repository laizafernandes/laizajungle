import { GetQueueUrlCommand, type SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { EventPublisherPort } from '../../application/index';
import type { OutboxMessage } from '../../domain/index';
import { type AppEnvConfig, loadEnvConfig } from '../config/env.config';
import { SQS_CLIENT_TOKEN } from './sqs.client';

@Injectable()
export class SqsOutboxEventPublisher implements EventPublisherPort {
  private cachedQueueUrl?: string;
  private readonly config: AppEnvConfig;

  constructor(
    @Inject(SQS_CLIENT_TOKEN) private readonly sqsClient: SQSClient,
    @Optional() config?: AppEnvConfig,
  ) {
    this.config = config ?? loadEnvConfig();
  }

  async publish(message: OutboxMessage): Promise<void> {
    const queueUrl = await this.getQueueUrl();

    await this.sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: {
            DataType: 'String',
            StringValue: message.eventType,
          },
          eventId: {
            DataType: 'String',
            StringValue: message.id,
          },
        },
      }),
    );
  }

  private async getQueueUrl(): Promise<string> {
    if (this.cachedQueueUrl) {
      return this.cachedQueueUrl;
    }

    const res = await this.sqsClient.send(
      new GetQueueUrlCommand({ QueueName: this.config.sqs.eventsQueueName }),
    );
    if (!res.QueueUrl) {
      throw new Error(`Unable to resolve SQS events queue URL: ${this.config.sqs.eventsQueueName}`);
    }
    this.cachedQueueUrl = res.QueueUrl;
    return res.QueueUrl;
  }
}
