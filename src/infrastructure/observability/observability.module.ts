import { GetQueueAttributesCommand, GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { Global, Module } from '@nestjs/common';
import { LOGGER_PORT, METRICS_PORT, PROVIDER_IDENTITY_PORT } from '../../application/index';
import { MetricsController } from '../../presentation/http/controllers/metrics.controller';
import {
  NoopProviderAuthGuard,
  NoopProviderIdentityAdapter,
} from '../../presentation/http/guards/noop-provider-auth.guard';
import { loadEnvConfig } from '../config/env.config';
import { SQS_CLIENT_TOKEN } from '../messaging/sqs.client';
import { JsonStructuredLogger } from './json-structured-logger';
import { PrometheusMetricsRegistry } from './prometheus-metrics-registry';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: LOGGER_PORT,
      useFactory: () => new JsonStructuredLogger(),
    },
    {
      provide: METRICS_PORT,
      inject: [EntityManager, SQS_CLIENT_TOKEN],
      useFactory: (em: EntityManager, sqsClient: SQSClient) => {
        const config = loadEnvConfig();
        let cachedDlqUrl: string | undefined;

        return new PrometheusMetricsRegistry({
          cacheTtlMs: 3000,
          readOutboxLag: async () => {
            const forked = em.fork();
            const rows = await forked
              .getConnection()
              .execute<Array<{ pending_count: number | string; oldest_lag_ms: number | string }>>(
                `SELECT COUNT(*)::int AS pending_count,
                        COALESCE(FLOOR(EXTRACT(EPOCH FROM (NOW() - MIN(occurred_at))) * 1000), 0)::bigint AS oldest_lag_ms
                 FROM outbox_messages
                 WHERE published_at IS NULL`,
              );
            const row = rows[0];
            return {
              pendingCount: Number(row?.pending_count ?? 0),
              oldestLagMs: Math.max(0, Number(row?.oldest_lag_ms ?? 0)),
            };
          },
          readDlqDepth: async () => {
            if (!cachedDlqUrl) {
              const urlRes = await sqsClient.send(
                new GetQueueUrlCommand({ QueueName: config.sqs.wagerDlqName }),
              );
              cachedDlqUrl = urlRes.QueueUrl;
            }
            if (!cachedDlqUrl) {
              throw new Error(`Missing DLQ URL for ${config.sqs.wagerDlqName}`);
            }

            const attrsRes = await sqsClient.send(
              new GetQueueAttributesCommand({
                QueueUrl: cachedDlqUrl,
                AttributeNames: [
                  'ApproximateNumberOfMessages',
                  'ApproximateNumberOfMessagesNotVisible',
                ],
              }),
            );
            return {
              approximateVisible: Number(attrsRes.Attributes?.ApproximateNumberOfMessages ?? 0),
              approximateNotVisible: Number(
                attrsRes.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0,
              ),
            };
          },
        });
      },
    },
    {
      provide: PROVIDER_IDENTITY_PORT,
      useClass: NoopProviderIdentityAdapter,
    },
    NoopProviderAuthGuard,
  ],
  exports: [LOGGER_PORT, METRICS_PORT, PROVIDER_IDENTITY_PORT, NoopProviderAuthGuard],
})
export class ObservabilityModule {}
