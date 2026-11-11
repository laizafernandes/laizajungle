import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(30_000);

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
import { LOGGER_PORT } from '../../src/application/index';
import { loadEnvConfig } from '../../src/infrastructure/config/env.config';
import { SQS_CLIENT_TOKEN } from '../../src/infrastructure/messaging/sqs.client';
import type { JsonStructuredLogger } from '../../src/infrastructure/observability/json-structured-logger';
import { SqsWagerConsumerService } from '../../src/presentation/sqs/sqs-wager-consumer.service';

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

describe('Limites numéricos de numeric(18,2) (Postgres e LocalStack reais)', () => {
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

  async function openWallet(
    amount: string,
    playerId = randomUUID(),
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount, currency: 'BRL' },
      }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('POST /wallets com saldo inicial no limite do numeric(18,2) (9999999999999999.99) é criado (201) e acima retorna 400 INVALID_MONEY', async () => {
    const okRes = await openWallet('9999999999999999.99');
    expect(okRes.status).toBe(201);

    const overRes = await openWallet('10000000000000000.00');
    expect(overRes.status).toBe(400);
    expect(overRes.body.errorCode).toBe('INVALID_MONEY');
  });

  it('HTTP: WIN que excederia o limite de numeric(18,2) retorna 422 BALANCE_LIMIT_EXCEEDED sem persistir transação nem alterar saldo/ledger', async () => {
    const playerId = randomUUID();
    const openRes = await openWallet('9999999999999999.99', playerId);
    expect(openRes.status).toBe(201);
    const walletId = openRes.body.id as string;

    const payload = {
      providerId: 'prov',
      externalTransactionId: 'overflow-win-1',
      playerId,
      walletId,
      roundId: 'r-1',
      gameId: 'g-1',
      kind: 'WIN',
      money: { amount: '1.00', currency: 'BRL' },
    };

    const res = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'overflow-win-1' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.errorCode).toBe('BALANCE_LIMIT_EXCEEDED');

    // Reenvio com mesma chave recalcula e repete 422 (sem persistência prévia)
    const replayRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'overflow-win-1' },
      body: JSON.stringify(payload),
    });
    expect(replayRes.status).toBe(422);
    expect(((await replayRes.json()) as Record<string, unknown>).errorCode).toBe(
      'BALANCE_LIMIT_EXCEEDED',
    );

    const em = orm.em.fork();
    const balance = (await em.execute(
      'select balance_amount::text as b from wallets where id = ?',
      [walletId],
    )) as Array<{ b: string }>;
    expect(balance[0]?.b).toBe('9999999999999999.99');

    const ledger = (await em.execute(
      'select count(*)::int as n from wallet_ledger_entries where wallet_id = ?',
      [walletId],
    )) as Array<{ n: number }>;
    expect(ledger[0]?.n).toBe(1);

    const txs = (await em.execute(
      "select count(*)::int as n from wager_transactions where wallet_id = ? and kind <> 'OPENING'",
      [walletId],
    )) as Array<{ n: number }>;
    expect(txs[0]?.n).toBe(0);
  });

  it('SQS: WIN que excederia numeric(18,2) é erro permanente -> DLQ sem retentativa transitória e sem alterar saldo/ledger', async () => {
    const playerId = randomUUID();
    const openRes = await openWallet('9999999999999999.99', playerId);
    expect(openRes.status).toBe(201);
    const walletId = openRes.body.id as string;

    const messageId = `msg-overflow-${randomUUID()}`;
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: mainQueueUrl,
        MessageGroupId: walletId,
        MessageDeduplicationId: messageId,
        MessageBody: JSON.stringify({
          messageId,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'prov',
            externalTransactionId: `overflow-sqs-${randomUUID()}`,
            idempotencyKey: `overflow-sqs-${randomUUID()}`,
            playerId,
            walletId,
            roundId: 'r-1',
            gameId: 'g-1',
            kind: 'WIN',
            money: { amount: '1.00', currency: 'BRL' },
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

    const em = orm.em.fork();
    const balance = (await em.execute(
      'select balance_amount::text as b from wallets where id = ?',
      [walletId],
    )) as Array<{ b: string }>;
    expect(balance[0]?.b).toBe('9999999999999999.99');
    const txs = (await em.execute(
      "select count(*)::int as n from wager_transactions where wallet_id = ? and kind <> 'OPENING'",
      [walletId],
    )) as Array<{ n: number }>;
    expect(txs[0]?.n).toBe(0);
  });
});
