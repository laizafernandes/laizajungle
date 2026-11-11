import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(60_000);

import { randomUUID } from 'node:crypto';
import {
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  type SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { waitForInfrastructure } from '../../scripts/wait-for-infra';
import { AppModule } from '../../src/app.module';
import { LOGGER_PORT, type OpenWalletResult } from '../../src/application/index';
import { loadEnvConfig } from '../../src/infrastructure/config/env.config';
import { SQS_CLIENT_TOKEN } from '../../src/infrastructure/messaging/sqs.client';
import type { JsonStructuredLogger } from '../../src/infrastructure/observability/json-structured-logger';
import { SqsWagerConsumerService } from '../../src/presentation/sqs/sqs-wager-consumer.service';

const LIMITS: Record<string, number> = {
  providerId: 100,
  externalTransactionId: 255,
  roundId: 255,
  gameId: 255,
  referenceExternalTransactionId: 255,
  idempotencyKey: 255,
};

async function waitUntil<T>(fn: () => Promise<T | null | undefined | false>): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) {
      return result;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitUntil timed out');
}

describe('Validação de tamanho máximo de campos string (HTTP 400 / SQS permanente) — Postgres e LocalStack reais', () => {
  let app: INestApplication;
  let baseUrl: string;
  let orm: MikroORM;
  let sqsClient: SQSClient;
  let consumer: SqsWagerConsumerService;
  let logger: JsonStructuredLogger;
  let mainQueueUrl: string;
  let dlqUrl: string;
  const logs: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    process.env.SQS_CONSUMER_ENABLED = 'false';
    process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
    process.env.PENDING_REF_WORKER_ENABLED = 'false';
    await waitForInfrastructure({ silent: true });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    const server = app.getHttpServer() as { address: () => { port: number } };
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    orm = app.get(MikroORM);
    sqsClient = app.get<SQSClient>(SQS_CLIENT_TOKEN);
    consumer = app.get(SqsWagerConsumerService);
    logger = app.get<JsonStructuredLogger>(LOGGER_PORT);
    logger.setSink((_level, raw) => {
      logs.push(JSON.parse(raw) as Record<string, unknown>);
    });
    const cfg = loadEnvConfig();
    const [m, d] = await Promise.all([
      sqsClient.send(new GetQueueUrlCommand({ QueueName: cfg.sqs.wagerQueueName })),
      sqsClient.send(new GetQueueUrlCommand({ QueueName: cfg.sqs.wagerDlqName })),
    ]);
    mainQueueUrl = m.QueueUrl ?? '';
    dlqUrl = d.QueueUrl ?? '';
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
    logs.length = 0;
    const migrator = orm.getMigrator();
    await migrator.down({ to: 0 });
    await migrator.up();
    await Promise.all([
      sqsClient.send(new PurgeQueueCommand({ QueueUrl: mainQueueUrl })),
      sqsClient.send(new PurgeQueueCommand({ QueueUrl: dlqUrl })),
    ]);
  });

  async function createWallet(playerId: string): Promise<OpenWalletResult> {
    const res = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as OpenWalletResult;
  }

  function basePayload(playerId: string, walletId: string): Record<string, unknown> {
    return {
      providerId: 'prov',
      externalTransactionId: `ext-${randomUUID()}`,
      playerId,
      walletId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
    };
  }

  async function postHttp(
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('HTTP: campo acima do limite -> 400 INVALID_PAYLOAD; exatamente no limite -> aceito', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId);

    for (const [field, max] of Object.entries(LIMITS)) {
      const tooLong = 'x'.repeat(max + 1);
      const exact = 'y'.repeat(max);

      const over = basePayload(playerId, wallet.id);
      let overKey = `k-${randomUUID()}`;
      if (field === 'idempotencyKey') {
        overKey = tooLong;
      } else if (field === 'referenceExternalTransactionId') {
        over.kind = 'REFUND';
        over.referenceExternalTransactionId = tooLong;
      } else {
        over[field] = tooLong;
      }
      const overRes = await postHttp(over, overKey);
      expect({ field, status: overRes.status, code: overRes.body.errorCode }).toEqual({
        field,
        status: 400,
        code: 'INVALID_PAYLOAD',
      });

      if (field !== 'referenceExternalTransactionId') {
        const ok = basePayload(playerId, wallet.id);
        let okKey = `k-${randomUUID()}`;
        if (field === 'idempotencyKey') {
          okKey = exact;
        } else {
          ok[field] = exact;
        }
        const okRes = await postHttp(ok, okKey);
        expect({ field, status: okRes.status }).toEqual({ field, status: 200 });
      }
    }
  });

  it('SQS: campo acima do limite -> erro permanente: DLQ sem log de retentativa transitória e sem efeito', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId);
    const messageId = `msg-long-${randomUUID()}`;
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: mainQueueUrl,
        MessageGroupId: wallet.id,
        MessageDeduplicationId: messageId,
        MessageBody: JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            ...basePayload(playerId, wallet.id),
            providerId: 'p'.repeat(150),
            idempotencyKey: `k-${randomUUID()}`,
          },
        }),
      }),
    );

    const dlqMsg = await waitUntil(async () => {
      await consumer.pollAndProcessOnce();
      const res = await sqsClient.send(
        new ReceiveMessageCommand({ QueueUrl: dlqUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 0 }),
      );
      return res.Messages?.[0] ?? false;
    });
    expect(dlqMsg.Body).toContain(messageId);
    expect(logs.some((l) => l.event === 'sqs_message_retry')).toBe(false);
    expect(logs.some((l) => l.event === 'sqs_message_dlq_routed')).toBe(true);

    const rows = (await orm.em
      .fork()
      .execute(
        `select count(*)::int as n from wager_transactions where kind <> 'OPENING'`,
      )) as Array<{
      n: number;
    }>;
    expect(rows[0]?.n).toBe(0);
  });
});
