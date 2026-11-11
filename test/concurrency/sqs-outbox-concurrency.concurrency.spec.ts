import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(30_000);

import { randomUUID } from 'node:crypto';
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Decimal from 'decimal.js';
import { waitForInfrastructure } from '../../scripts/wait-for-infra';
import { AppModule } from '../../src/app.module';
import { type OpenWalletResult, OutboxPublisherUseCase } from '../../src/application/index';
import { type SerializedIntegrationEvent, WagerTransactionKind } from '../../src/domain/index';
import { loadEnvConfig } from '../../src/infrastructure/config/env.config';
import { SQS_CLIENT_TOKEN } from '../../src/infrastructure/messaging/sqs.client';
import { SqsWagerConsumerService } from '../../src/presentation/sqs/sqs-wager-consumer.service';

async function waitUntil<T>(
  fn: () => Promise<T | null | undefined | false>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) {
      return result;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms (${options.label ?? 'condition'})`);
}

async function assertWalletMatchesLedger(orm: MikroORM, walletId: string): Promise<string> {
  const conn = orm.em.getConnection();
  const walletRows = await conn.execute<Array<{ balance_amount: string }>>(
    'SELECT balance_amount FROM wallets WHERE id = ?',
    [walletId],
  );
  const walletBalance = walletRows[0]?.balance_amount;
  expect(walletBalance).toBeDefined();

  const ledgerRows = await conn.execute<
    Array<{ transaction_id: string; direction: string; amount: string }>
  >(
    'SELECT transaction_id, direction, amount FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY created_at ASC, id ASC',
    [walletId],
  );

  const seen = new Set<string>();
  let calc = new Decimal(0);
  for (const row of ledgerRows) {
    expect(seen.has(row.transaction_id)).toBe(false);
    seen.add(row.transaction_id);
    const amt = new Decimal(row.amount);
    calc = row.direction === 'CREDIT' ? calc.plus(amt) : calc.minus(amt);
  }

  expect(walletBalance).toBe(calc.toFixed(2));
  return walletBalance ?? '0.00';
}

describe('Sprint 5 — Concurrent SQS Consumers & Outbox Publishers (Real Postgres + LocalStack)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let orm: MikroORM;
  let sqsClient: SQSClient;
  let consumerService: SqsWagerConsumerService;
  let outboxPublisherUseCase: OutboxPublisherUseCase;
  let mainQueueUrl: string;
  let dlqUrl: string;
  let eventsQueueUrl: string;

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
    consumerService = app.get(SqsWagerConsumerService);
    outboxPublisherUseCase = app.get(OutboxPublisherUseCase);

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
    consumerService.clearFaultHooks();
    outboxPublisherUseCase.clearFaultHooks();
    const migrator = orm.getMigrator();
    await migrator.down({ to: 0 });
    await migrator.up();

    await Promise.all([
      sqsClient.send(new PurgeQueueCommand({ QueueUrl: mainQueueUrl })),
      sqsClient.send(new PurgeQueueCommand({ QueueUrl: dlqUrl })),
      sqsClient.send(new PurgeQueueCommand({ QueueUrl: eventsQueueUrl })),
    ]);
  });

  async function createWallet(playerId: string, amount: string): Promise<OpenWalletResult> {
    const res = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount, currency: 'BRL' },
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as OpenWalletResult;
  }

  it('processes parallel wallets and ordered per-wallet operations across 3 concurrent consumers & 3 concurrent publishers without duplicates', async () => {
    const wallets = await Promise.all([
      createWallet(randomUUID(), '100.00'),
      createWallet(randomUUID(), '100.00'),
      createWallet(randomUUID(), '100.00'),
    ]);

    // Enqueue 10 BETs (15.00 each) per wallet -> 30 total messages (some will succeed, some REJECTED insufficient balance)
    const sendPromises: Array<Promise<unknown>> = [];
    for (let wIdx = 0; wIdx < wallets.length; wIdx++) {
      const wallet = wallets[wIdx];
      if (!wallet) continue;
      for (let i = 0; i < 10; i++) {
        const msgId = `conc-msg-${wIdx}-${i}`;
        sendPromises.push(
          sqsClient.send(
            new SendMessageCommand({
              QueueUrl: mainQueueUrl,
              MessageGroupId: wallet.id,
              MessageDeduplicationId: msgId,
              MessageBody: JSON.stringify({
                messageId: msgId,
                type: 'WagerTransactionRequested',
                occurredAt: new Date().toISOString(),
                data: {
                  providerId: 'provider-a',
                  externalTransactionId: `conc-tx-${wIdx}-${i}`,
                  idempotencyKey: `provider-a:conc-tx-${wIdx}-${i}`,
                  playerId: wallet.playerId,
                  walletId: wallet.id,
                  roundId: `r-conc-${wIdx}-${i}`,
                  gameId: 'fortune-chimp',
                  kind: WagerTransactionKind.Bet,
                  money: { amount: '15.00', currency: 'BRL' },
                },
              }),
            }),
          ),
        );
      }
    }
    await Promise.all(sendPromises);

    // Run 3 concurrent consumer pollers + 3 concurrent outbox publishers simultaneously
    await waitUntil(
      async () => {
        await Promise.all([
          consumerService.pollAndProcessOnce(),
          consumerService.pollAndProcessOnce(),
          consumerService.pollAndProcessOnce(),
          outboxPublisherUseCase.publishDueBatch(),
          outboxPublisherUseCase.publishDueBatch(),
          outboxPublisherUseCase.publishDueBatch(),
        ]);

        const rows = await orm.em
          .getConnection()
          .execute<Array<{ count: string }>>('SELECT count(*)::text AS count FROM inbox_messages');
        return rows[0]?.count === '30';
      },
      { label: '3 consumers process all 30 messages' },
    );

    // Drain any remaining outbox rows with 3 concurrent publishers
    await waitUntil(
      async () => {
        await Promise.all([
          outboxPublisherUseCase.publishDueBatch(),
          outboxPublisherUseCase.publishDueBatch(),
          outboxPublisherUseCase.publishDueBatch(),
        ]);
        const pending = await orm.em
          .getConnection()
          .execute<Array<{ count: string }>>(
            'SELECT count(*)::text AS count FROM outbox_messages WHERE published_at IS NULL',
          );
        return pending[0]?.count === '0';
      },
      { label: '3 publishers drain all outbox events' },
    );

    // Verify every wallet has 10.00 BRL (100 - 6*15 = 10) and matches ledger
    for (const wallet of wallets) {
      const finalBal = await assertWalletMatchesLedger(orm, wallet.id);
      expect(finalBal).toBe('10.00');
    }

    // Expected outbox events:
    // Per wallet: 2 (OPENING) + 6*(2 BET PROCESSED+BalanceChanged) + 4*(1 REJECTED) = 18 -> 54 total
    const outboxTotal = await orm.em
      .getConnection()
      .execute<Array<{ count: string }>>('SELECT count(*)::text AS count FROM outbox_messages');
    expect(outboxTotal[0]?.count).toBe('54');

    // Collect all events from wager-events.fifo and verify zero duplicate eventIds
    const receivedEventIds = new Set<string>();
    await waitUntil(
      async () => {
        const res = await sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: eventsQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 0,
          }),
        );
        for (const m of res.Messages ?? []) {
          if (m.Body) {
            const parsed = JSON.parse(m.Body) as SerializedIntegrationEvent;
            expect(receivedEventIds.has(parsed.eventId)).toBe(false);
            receivedEventIds.add(parsed.eventId);
          }
          if (m.ReceiptHandle) {
            await sqsClient.send(
              new DeleteMessageCommand({
                QueueUrl: eventsQueueUrl,
                ReceiptHandle: m.ReceiptHandle,
              }),
            );
          }
        }
        return receivedEventIds.size === 54;
      },
      { label: 'receive all 54 unique integration events from wager-events.fifo' },
    );
  });
});
