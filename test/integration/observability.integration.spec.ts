import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(30_000);

import { randomUUID } from 'node:crypto';
import {
  GetQueueUrlCommand,
  PurgeQueueCommand,
  type SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { waitForInfrastructure } from '../../scripts/wait-for-infra';
import { AppModule } from '../../src/app.module';
import {
  LOGGER_PORT,
  type OpenWalletResult,
  type ProcessWagerTransactionResult,
} from '../../src/application/index';
import { WagerTransactionKind } from '../../src/domain/index';
import { loadEnvConfig } from '../../src/infrastructure/config/env.config';
import { SQS_CLIENT_TOKEN } from '../../src/infrastructure/messaging/sqs.client';
import type { JsonStructuredLogger } from '../../src/infrastructure/observability/json-structured-logger';
import { SqsWagerConsumerService } from '../../src/presentation/sqs/sqs-wager-consumer.service';

describe('Sprint 6 — Observability Integration: Structured Logs without Monetary Data, Metrics & Health (Real Postgres + LocalStack)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let orm: MikroORM;
  let sqsClient: SQSClient;
  let logger: JsonStructuredLogger;
  let consumerService: SqsWagerConsumerService;
  let mainQueueUrl: string;
  let dlqUrl: string;
  let eventsQueueUrl: string;
  const logLines: Array<{ level: string; raw: string; parsed: Record<string, unknown> }> = [];

  beforeAll(async () => {
    process.env.SQS_CONSUMER_ENABLED = 'false';
    process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
    process.env.PENDING_REF_WORKER_ENABLED = 'false';

    await waitForInfrastructure({ silent: true });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');

    const server = app.getHttpServer() as { address: () => { port: number } };
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    orm = app.get(MikroORM);
    sqsClient = app.get<SQSClient>(SQS_CLIENT_TOKEN);
    logger = app.get<JsonStructuredLogger>(LOGGER_PORT);
    consumerService = app.get(SqsWagerConsumerService);

    logger.setSink((level, raw) => {
      logLines.push({
        level,
        raw,
        parsed: JSON.parse(raw) as Record<string, unknown>,
      });
    });

    const cfg = loadEnvConfig();
    const [mainRes, dlqRes, evtRes] = await Promise.all([
      sqsClient.send(new GetQueueUrlCommand({ QueueName: cfg.sqs.wagerQueueName })),
      sqsClient.send(new GetQueueUrlCommand({ QueueName: cfg.sqs.wagerDlqName })),
      sqsClient.send(new GetQueueUrlCommand({ QueueName: cfg.sqs.eventsQueueName })),
    ]);
    mainQueueUrl = mainRes.QueueUrl ?? '';
    dlqUrl = dlqRes.QueueUrl ?? '';
    eventsQueueUrl = evtRes.QueueUrl ?? '';
  });

  afterAll(async () => {
    Reflect.deleteProperty(process.env, 'SQS_CONSUMER_ENABLED');
    Reflect.deleteProperty(process.env, 'OUTBOX_PUBLISHER_ENABLED');
    Reflect.deleteProperty(process.env, 'PENDING_REF_WORKER_ENABLED');
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    logLines.length = 0;
    const migrator = orm.getMigrator();
    await migrator.down({ to: 0 });
    await migrator.up();

    await Promise.all([
      sqsClient.send(new PurgeQueueCommand({ QueueUrl: mainQueueUrl })).catch(() => undefined),
      sqsClient.send(new PurgeQueueCommand({ QueueUrl: dlqUrl })).catch(() => undefined),
      sqsClient.send(new PurgeQueueCommand({ QueueUrl: eventsQueueUrl })).catch(() => undefined),
    ]);
  });

  it('exposes /health/live, /health/ready, correlation logs free of monetary values, and low-cardinality /metrics', async () => {
    // 1. Verify health endpoints open without auth
    const liveRes = await fetch(`${baseUrl}/health/live`);
    expect(liveRes.status).toBe(200);
    const liveBody = (await liveRes.json()) as { status: string };
    expect(liveBody.status).toBe('ok');

    const readyRes = await fetch(`${baseUrl}/health/ready`);
    expect(readyRes.status).toBe(200);
    const readyBody = (await readyRes.json()) as {
      status: string;
      checks: { postgres: { status: string }; sqs: { status: string } };
    };
    expect(readyBody.status).toBe('ok');
    expect(readyBody.checks.postgres.status).toBe('up');
    expect(readyBody.checks.sqs.status).toBe('up');

    // 2. Open wallet with distinctive amount 432.19 & run BET 32.19 + replay + SQS message
    const playerId = randomUUID();
    const openRes = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': 'http-open-corr',
      },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '432.19', currency: 'BRL' },
      }),
    });
    expect(openRes.status).toBe(201);
    const wallet = (await openRes.json()) as OpenWalletResult;

    const betPayload = {
      providerId: 'provider-obs',
      externalTransactionId: 'bet-obs-1',
      playerId,
      walletId: wallet.id,
      roundId: 'r-obs-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '32.19', currency: 'BRL' },
    };

    const betRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': 'provider-obs:bet-obs-1',
        'x-correlation-id': 'http-bet-corr',
      },
      body: JSON.stringify(betPayload),
    });
    expect(betRes.status).toBe(200);
    const betBody = (await betRes.json()) as ProcessWagerTransactionResult;

    // Replay same key
    const replayRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': 'provider-obs:bet-obs-1',
        'x-correlation-id': 'http-replay-corr',
      },
      body: JSON.stringify(betPayload),
    });
    expect(replayRes.status).toBe(200);

    // 3. SQS transaction with distinctive amount 77.88 -> verifies messageId correlation in logs
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: mainQueueUrl,
        MessageGroupId: wallet.id,
        MessageDeduplicationId: 'obs-sqs-1',
        MessageBody: JSON.stringify({
          messageId: 'sqs-msg-obs-1',
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'provider-obs',
            externalTransactionId: 'win-obs-1',
            idempotencyKey: 'provider-obs:win-obs-1',
            playerId,
            walletId: wallet.id,
            roundId: 'r-obs-1',
            gameId: 'fortune-chimp',
            kind: WagerTransactionKind.Win,
            money: { amount: '77.88', currency: 'BRL' },
          },
        }),
      }),
    );

    const sqsAcked = await consumerService.pollAndProcessOnce();
    expect(sqsAcked).toBe(1);

    // 4. Corrupt wallet balance directly in DB to trigger reconciliation mismatch metric & log without monetary values
    await orm.em
      .getConnection()
      .execute("UPDATE wallets SET balance_amount = '999.99' WHERE id = ?", [wallet.id]);

    const reconRes = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
      headers: { 'x-correlation-id': 'http-recon-corr' },
    });
    expect(reconRes.status).toBe(200);
    const reconBody = (await reconRes.json()) as { consistent: boolean };
    expect(reconBody.consistent).toBe(false);

    // Verify correlation fields exist in logs and zero monetary amounts leaked
    const httpBetLog = logLines.find(
      (l) =>
        l.parsed.event === 'wager_transaction_processed' && l.parsed.correlationId === 'http-bet-corr',
    );
    expect(httpBetLog).toBeDefined();
    expect(httpBetLog?.parsed.transactionId).toBe(betBody.transactionId);
    expect(httpBetLog?.parsed.walletId).toBe(wallet.id);
    expect(httpBetLog?.parsed.providerId).toBe('provider-obs');

    const sqsLog = logLines.find((l) => l.parsed.messageId === 'sqs-msg-obs-1');
    expect(sqsLog).toBeDefined();
    expect(sqsLog?.parsed.walletId).toBe(wallet.id);

    const reconLog = logLines.find((l) => l.parsed.event === 'wallet_reconciliation_mismatch');
    expect(reconLog).toBeDefined();
    expect(reconLog?.parsed.walletId).toBe(wallet.id);

    for (const entry of logLines) {
      expect(entry.raw).not.toContain('432.19');
      expect(entry.raw).not.toContain('32.19');
      expect(entry.raw).not.toContain('77.88');
      expect(entry.raw).not.toContain('999.99');
      expect(entry.raw).not.toContain('"storedBalance"');
      expect(entry.raw).not.toContain('"calculatedBalance"');
      expect(entry.raw).not.toContain('"difference"');
      expect(entry.raw).not.toContain('"amount"');
    }

    // 5. Verify /metrics endpoint (Prometheus text + JSON)
    const promRes = await fetch(`${baseUrl}/metrics`);
    expect(promRes.status).toBe(200);
    expect(promRes.headers.get('content-type')).toContain('text/plain');
    const promText = await promRes.text();

    expect(promText).toContain('wager_transactions_total{kind="BET",status="PROCESSED"} 1');
    expect(promText).toContain('wager_transactions_total{kind="WIN",status="PROCESSED"} 1');
    expect(promText).toContain('wager_duplicates_total{channel="http",mechanism="idempotency_key"} 1');
    expect(promText).toContain('wager_reconciliation_mismatches_total 1');
    expect(promText).toContain('wager_outbox_pending_count');
    expect(promText).toContain('wager_processing_duration_ms_count');
    // Zero entity IDs in metric labels
    expect(promText).not.toContain(wallet.id);
    expect(promText).not.toContain(playerId);
    expect(promText).not.toContain('provider-obs');

    const jsonMetricsRes = await fetch(`${baseUrl}/metrics?format=json`);
    expect(jsonMetricsRes.status).toBe(200);
    const jsonMetrics = (await jsonMetricsRes.json()) as {
      outbox: { pendingCount: number };
      reconciliationMismatches: number;
    };
    expect(jsonMetrics.outbox.pendingCount).toBeGreaterThanOrEqual(4);
    expect(jsonMetrics.reconciliationMismatches).toBe(1);
  });
});
