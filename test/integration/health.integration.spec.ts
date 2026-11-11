import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { waitForInfrastructure } from '../../scripts/wait-for-infra';
import { AppModule } from '../../src/app.module';
import type {
  LivenessStatus,
  ReadinessStatus,
} from '../../src/application/ports/health-checker.port';
import { loadEnvConfig } from '../../src/infrastructure/config/env.config';
import { SQS_CLIENT_TOKEN, verifySqsQueues } from '../../src/infrastructure/messaging/sqs.client';

describe('Sprint 0 — Health & Real Infrastructure Integration', () => {
  let app: INestApplication;
  let baseUrl: string;
  let em: EntityManager;
  let sqsClient: SQSClient;

  beforeAll(async () => {
    await waitForInfrastructure({ silent: true });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');

    const server = app.getHttpServer() as { address: () => { port: number } };
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;

    em = app.get(EntityManager);
    sqsClient = app.get<SQSClient>(SQS_CLIENT_TOKEN);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('connects to real PostgreSQL via MikroORM EntityManager and executes SQL', async () => {
    const forkedEm = em.fork();
    const rows = await forkedEm
      .getConnection()
      .execute<Array<{ db_name: string; connected: number }>>(
        'SELECT current_database() AS db_name, 1 AS connected',
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.connected).toBe(1);
    expect(rows[0]?.db_name).toBe(loadEnvConfig().db.name);
  });

  it('verifies real LocalStack SQS FIFO queues and RedrivePolicy (DLQ)', async () => {
    const verification = await verifySqsQueues(sqsClient, loadEnvConfig());

    expect(verification.fifoEnabled).toBe(true);
    expect(verification.maxReceiveCount).toBe(3);
    expect(verification.wagerQueueUrl).toContain('wager-transactions.fifo');
    expect(verification.wagerDlqUrl).toContain('wager-transactions-dlq.fifo');
  });

  it('returns 200 OK on GET /health/live', async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as LivenessStatus;
    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('returns 200 OK on GET /health/ready and GET /health with real Postgres and SQS status', async () => {
    for (const path of ['/health/ready', '/health']) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status).toBe(200);

      const body = (await response.json()) as ReadinessStatus;
      expect(body.status).toBe('ok');
      expect(body.checks.postgres.status).toBe('up');
      expect(body.checks.postgres.latencyMs).toBeGreaterThanOrEqual(0);
      expect(body.checks.sqs.status).toBe('up');
      expect(body.checks.sqs.latencyMs).toBeGreaterThanOrEqual(0);
      expect(body.checks.sqs.details?.fifoEnabled).toBe(true);
    }
  });
});
