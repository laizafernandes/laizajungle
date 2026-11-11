import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { type AppEnvConfig, loadEnvConfig } from '../config/env.config';

export const SQS_CLIENT_TOKEN = Symbol('SQS_CLIENT_TOKEN');

export function createSqsClient(config: AppEnvConfig = loadEnvConfig()): SQSClient {
  return new SQSClient({
    region: config.sqs.region,
    endpoint: config.sqs.endpoint,
    credentials: {
      accessKeyId: config.sqs.accessKeyId,
      secretAccessKey: config.sqs.secretAccessKey,
    },
  });
}

export interface SqsQueueVerification {
  wagerQueueUrl: string;
  wagerDlqUrl: string;
  eventsQueueUrl: string;
  fifoEnabled: boolean;
  maxReceiveCount: number;
}

export async function verifySqsQueues(
  client: SQSClient,
  config: AppEnvConfig = loadEnvConfig(),
): Promise<SqsQueueVerification> {
  const [mainUrlRes, dlqUrlRes, eventsUrlRes] = await Promise.all([
    client.send(new GetQueueUrlCommand({ QueueName: config.sqs.wagerQueueName })),
    client.send(new GetQueueUrlCommand({ QueueName: config.sqs.wagerDlqName })),
    client.send(new GetQueueUrlCommand({ QueueName: config.sqs.eventsQueueName })),
  ]);

  if (!mainUrlRes.QueueUrl || !dlqUrlRes.QueueUrl || !eventsUrlRes.QueueUrl) {
    throw new Error('Required SQS FIFO queue URLs were not returned by broker');
  }

  const attrsRes = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: mainUrlRes.QueueUrl,
      AttributeNames: ['FifoQueue', 'RedrivePolicy'],
    }),
  );

  const fifoEnabled = attrsRes.Attributes?.FifoQueue === 'true';
  const redriveRaw = attrsRes.Attributes?.RedrivePolicy;
  if (!redriveRaw) {
    throw new Error(`Missing RedrivePolicy on queue ${config.sqs.wagerQueueName}`);
  }

  const redrive = JSON.parse(redriveRaw) as {
    deadLetterTargetArn?: string;
    maxReceiveCount?: string | number;
  };
  const maxReceiveCount = Number(redrive.maxReceiveCount ?? 0);

  return {
    wagerQueueUrl: mainUrlRes.QueueUrl,
    wagerDlqUrl: dlqUrlRes.QueueUrl,
    eventsQueueUrl: eventsUrlRes.QueueUrl,
    fifoEnabled,
    maxReceiveCount,
  };
}
