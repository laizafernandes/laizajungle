import type { SQSClient } from '@aws-sdk/client-sqs';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { loadEnvConfig } from '../config/env.config';
import { SQS_CLIENT_TOKEN, createSqsClient } from './sqs.client';

@Global()
@Module({
  providers: [
    {
      provide: SQS_CLIENT_TOKEN,
      useFactory: () => createSqsClient(loadEnvConfig()),
    },
  ],
  exports: [SQS_CLIENT_TOKEN],
})
export class MessagingModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT_TOKEN) private readonly sqsClient: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqsClient.destroy();
  }
}
