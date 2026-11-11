import type { SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { Inject, Injectable } from '@nestjs/common';
import type {
  ComponentHealthResult,
  LivenessStatus,
  ReadinessStatus,
} from '../../application/ports/health-checker.port';
import { loadEnvConfig } from '../config/env.config';
import { SQS_CLIENT_TOKEN, verifySqsQueues } from '../messaging/sqs.client';

@Injectable()
export class HealthService {
  constructor(
    private readonly em: EntityManager,
    @Inject(SQS_CLIENT_TOKEN) private readonly sqsClient: SQSClient,
  ) {}

  getLiveness(): LivenessStatus {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  async getReadiness(): Promise<ReadinessStatus> {
    const [postgres, sqs] = await Promise.all([this.checkPostgres(), this.checkSqs()]);
    const allUp = postgres.status === 'up' && sqs.status === 'up';

    return {
      status: allUp ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks: {
        postgres,
        sqs,
      },
    };
  }

  private async checkPostgres(): Promise<ComponentHealthResult> {
    const start = performance.now();
    try {
      const forkedEm = this.em.fork();
      const rows = await forkedEm.getConnection().execute<Array<{ ok: number }>>('SELECT 1 AS ok');
      const isOk = rows[0]?.ok === 1;

      return {
        status: isOk ? 'up' : 'down',
        latencyMs: Math.round(performance.now() - start),
      };
    } catch (error) {
      return {
        status: 'down',
        latencyMs: Math.round(performance.now() - start),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async checkSqs(): Promise<ComponentHealthResult> {
    const start = performance.now();
    try {
      const verification = await verifySqsQueues(this.sqsClient, loadEnvConfig());
      return {
        status: 'up',
        latencyMs: Math.round(performance.now() - start),
        details: {
          fifoEnabled: verification.fifoEnabled,
          maxReceiveCount: verification.maxReceiveCount,
          queues: [verification.wagerQueueUrl, verification.wagerDlqUrl],
        },
      };
    } catch (error) {
      return {
        status: 'down',
        latencyMs: Math.round(performance.now() - start),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
