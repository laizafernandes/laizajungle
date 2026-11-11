import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(30_000);

import { randomUUID } from 'node:crypto';
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { waitForInfrastructure } from '../../scripts/wait-for-infra';
import { AppModule } from '../../src/app.module';
import {
  type OpenWalletResult,
  OutboxPublisherUseCase,
  ProcessPendingReferencesUseCase,
  type ProcessWagerTransactionResult,
} from '../../src/application/index';
import {
  FailureCode,
  type SerializedIntegrationEvent,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/index';
import { loadEnvConfig } from '../../src/infrastructure/config/env.config';
import { SQS_CLIENT_TOKEN } from '../../src/infrastructure/messaging/sqs.client';
import { SqsWagerConsumerService } from '../../src/presentation/sqs/sqs-wager-consumer.service';

async function waitUntil<T>(
  fn: () => Promise<T | null | undefined | false>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 15_000;
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

describe('Sprint 5 — SQS FIFO, Persistent Inbox & Transactional Outbox (Real Postgres + LocalStack)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let orm: MikroORM;
  let sqsClient: SQSClient;
  let consumerService: SqsWagerConsumerService;
  let outboxPublisherUseCase: OutboxPublisherUseCase;
  let pendingWorkerUseCase: ProcessPendingReferencesUseCase;
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
    pendingWorkerUseCase = app.get(ProcessPendingReferencesUseCase);

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

  async function enqueueInboundSqs(
    walletId: string,
    envelope: Record<string, unknown>,
    dedupId?: string,
  ): Promise<void> {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: mainQueueUrl,
        MessageGroupId: walletId,
        MessageDeduplicationId: dedupId ?? String(envelope.messageId ?? randomUUID()),
        MessageBody: JSON.stringify(envelope),
      }),
    );
  }

  async function receiveAllEvents(expectedCount: number): Promise<SerializedIntegrationEvent[]> {
    const collected: SerializedIntegrationEvent[] = [];
    await waitUntil(
      async () => {
        const res = await sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: eventsQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 0,
            VisibilityTimeout: 5,
          }),
        );
        for (const msg of res.Messages ?? []) {
          if (msg.Body) {
            collected.push(JSON.parse(msg.Body) as SerializedIntegrationEvent);
          }
          if (msg.ReceiptHandle) {
            await sqsClient.send(
              new DeleteMessageCommand({
                QueueUrl: eventsQueueUrl,
                ReceiptHandle: msg.ReceiptHandle,
              }),
            );
          }
        }
        return collected.length >= expectedCount ? collected : false;
      },
      { label: `receive ${expectedCount} events` },
    );
    return collected;
  }

  it('writes Inbox + Outbox atomically per state transition (no WalletBalanceChanged on LOSS/REJECTED, zero outbox on rollback)', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId, '100.00'); // OPENING -> Processed + BalanceChanged (2 events)

    // 1. BET via SQS -> Processed + BalanceChanged (2 events)
    await enqueueInboundSqs(wallet.id, {
      messageId: 'msg-bet-1',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'sqs-bet-1',
        idempotencyKey: 'provider-a:sqs-bet-1',
        playerId,
        walletId: wallet.id,
        roundId: 'r-1',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
      },
    });

    // 2. LOSS via SQS -> Processed ONLY (1 event, NO WalletBalanceChanged)
    await enqueueInboundSqs(wallet.id, {
      messageId: 'msg-loss-1',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'sqs-loss-1',
        idempotencyKey: 'provider-a:sqs-loss-1',
        playerId,
        walletId: wallet.id,
        roundId: 'r-2',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Loss,
        money: { amount: '10.00', currency: 'BRL' },
      },
    });

    // 3. Insufficient BET via SQS -> REJECTED (1 event WagerTransactionRejected, ACKed cleanly)
    await enqueueInboundSqs(wallet.id, {
      messageId: 'msg-rej-1',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'sqs-rej-1',
        idempotencyKey: 'provider-a:sqs-rej-1',
        playerId,
        walletId: wallet.id,
        roundId: 'r-3',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '500.00', currency: 'BRL' },
      },
    });

    await waitUntil(
      async () => {
        await consumerService.pollAndProcessOnce();
        const rows = await orm.em
          .getConnection()
          .execute<Array<{ count: string }>>('SELECT count(*)::text AS count FROM inbox_messages');
        return rows[0]?.count === '3';
      },
      { label: 'consume 3 SQS messages' },
    );

    // Rollback case: WALLET_NOT_FOUND via HTTP leaves zero extra rows in outbox
    const missingWalletRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'k-missing' },
      body: JSON.stringify({
        providerId: 'provider-a',
        externalTransactionId: 'tx-missing',
        playerId,
        walletId: randomUUID(),
        roundId: 'r-miss',
        gameId: 'g-miss',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      }),
    });
    expect(missingWalletRes.status).toBe(404);

    // Outbox count: 2 (OPENING) + 2 (BET) + 1 (LOSS) + 1 (REJECTED) = 6 events
    const outboxRows = await orm.em
      .getConnection()
      .execute<Array<{ event_type: string }>>(
        'SELECT event_type FROM outbox_messages ORDER BY occurred_at ASC, id ASC',
      );
    expect(outboxRows.map((r) => r.event_type)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WagerTransactionProcessed',
      'WagerTransactionRejected',
    ]);

    await outboxPublisherUseCase.publishDueBatch();
    const publishedEvents = await receiveAllEvents(6);
    expect(publishedEvents).toHaveLength(6);
  });

  it('handles duplicate messageId, redelivery after crash between commit and ack, and divergent payload per messageId -> DLQ', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId, '100.00');

    const envelope = {
      messageId: 'msg-crash-ack-1',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'crash-bet-1',
        idempotencyKey: 'provider-a:crash-bet-1',
        playerId,
        walletId: wallet.id,
        roundId: 'r-crash',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '25.00', currency: 'BRL' },
      },
    };

    // Simulate process crash AFTER PostgreSQL commit and BEFORE SQS DeleteMessage (ack)
    let crashedOnce = false;
    consumerService.setFaultHooks({
      afterCommitBeforeAck: () => {
        if (!crashedOnce) {
          crashedOnce = true;
          throw new Error('SIMULATED_CRASH_BEFORE_ACK');
        }
      },
    });

    await enqueueInboundSqs(wallet.id, envelope, 'dedup-crash-1');

    await waitUntil(
      async () => {
        await consumerService.pollAndProcessOnce();
        return crashedOnce;
      },
      { label: 'first attempt crashes after commit' },
    );

    // Second copy / redelivery with SAME messageId (different SQS dedupId to force redelivery immediately)
    await enqueueInboundSqs(wallet.id, envelope, 'dedup-crash-2');

    await waitUntil(
      async () => {
        const processed = await consumerService.pollAndProcessOnce();
        return processed > 0;
      },
      { label: 'redelivery succeeds cleanly via inbox' },
    );

    // Balance must only be debited ONCE (100 - 25 = 75)
    const walletRow = await orm.em
      .getConnection()
      .execute<Array<{ balance_amount: string }>>(
        'SELECT balance_amount FROM wallets WHERE id = ?',
        [wallet.id],
      );
    expect(walletRow[0]?.balance_amount).toBe('75.00');

    // Now send SAME messageId with DIFFERENT payload -> permanent error -> moves to DLQ after maxReceiveCount=3
    await enqueueInboundSqs(
      wallet.id,
      {
        ...envelope,
        data: {
          ...envelope.data,
          money: { amount: '99.00', currency: 'BRL' },
        },
      },
      'dedup-divergent-msg',
    );

    const dlqMsg = await waitUntil(
      async () => {
        await consumerService.pollAndProcessOnce();
        const res = await sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: dlqUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 0,
          }),
        );
        return res.Messages?.[0] ?? false;
      },
      { label: 'divergent messageId arrives in DLQ' },
    );
    expect(dlqMsg.Body).toContain('99.00');
  });

  it('recovers safely when publisher crashes between SendMessage and markPublished (preserving stable eventId) and when SQS is unavailable', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId, '100.00');

    // Simulate publisher crash AFTER SQS SendMessage and BEFORE markPublished
    let crashedAfterSend = false;
    outboxPublisherUseCase.setFaultHooks({
      afterSendBeforeMarkPublished: () => {
        if (!crashedAfterSend) {
          crashedAfterSend = true;
          throw new Error('SIMULATED_CRASH_BEFORE_MARK_PUBLISHED');
        }
      },
    });

    const batch1 = await outboxPublisherUseCase.publishDueBatch();
    expect(crashedAfterSend).toBe(true);
    expect(batch1.failed).toBeGreaterThan(0);

    // Outbox entries remain unpublished in PostgreSQL
    const pendingBeforeRetry = await orm.em
      .getConnection()
      .execute<Array<{ id: string; attempts: number }>>(
        'SELECT id, attempts FROM outbox_messages WHERE published_at IS NULL ORDER BY occurred_at ASC',
      );
    expect(pendingBeforeRetry.length).toBeGreaterThan(0);

    // Clear fault hook and publish again (step clock forward past backoff)
    outboxPublisherUseCase.clearFaultHooks();
    const batch2 = await outboxPublisherUseCase.publishDueBatch({
      now: new Date(Date.now() + 60_000),
    });
    expect(batch2.published).toBeGreaterThanOrEqual(1);
    expect(batch1.published + batch2.published).toBe(2);

    // Because MessageDeduplicationId = outbox.id, LocalStack FIFO deduplicates the re-sent eventId!
    const events = await receiveAllEvents(2);
    expect(events).toHaveLength(2);

    // Simulate SQS unavailable while HTTP traffic continues normally
    const unreachableSqs = new SQSClient({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestHandler: { requestTimeout: 300 },
    });

    try {
      const cfg = loadEnvConfig();
      const { SqsOutboxEventPublisher } = await import(
        '../../src/infrastructure/messaging/sqs-outbox-event.publisher'
      );
      const { MikroOrmOutboxRepository } = await import(
        '../../src/infrastructure/database/adapters/mikro-orm-outbox.repository'
      );
      const { MikroOrmUnitOfWork } = await import(
        '../../src/infrastructure/database/adapters/mikro-orm-unit-of-work'
      );
      const { SystemClock } = await import('../../src/infrastructure/system/system-adapters');

      const brokenPublisher = new OutboxPublisherUseCase(
        new MikroOrmUnitOfWork(orm.em),
        new MikroOrmOutboxRepository(orm.em),
        new SqsOutboxEventPublisher(unreachableSqs, cfg),
        new SystemClock(),
      );

      // HTTP BET succeeds while SQS is down!
      const httpRes = await fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': 'http-while-sqs-down' },
        body: JSON.stringify({
          providerId: 'provider-a',
          externalTransactionId: 'tx-while-sqs-down',
          playerId,
          walletId: wallet.id,
          roundId: 'r-down',
          gameId: 'fortune-chimp',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        }),
      });
      expect(httpRes.status).toBe(200);
      const httpBody = (await httpRes.json()) as ProcessWagerTransactionResult;
      expect(httpBody.balance.amount).toBe('90.00');

      const failedBatch = await brokenPublisher.publishDueBatch({
        now: new Date(Date.now() + 60_000),
      });
      expect(failedBatch.failed).toBe(2);

      // SQS comes back -> real publisher drains accumulated outbox
      const drained = await outboxPublisherUseCase.publishDueBatch({
        now: new Date(Date.now() + 120_000),
      });
      expect(drained.published).toBe(2);

      const drainedEvents = await receiveAllEvents(2);
      expect(drainedEvents).toHaveLength(2);
    } finally {
      unreachableSqs.destroy();
    }
  });

  it('routes malformed/invalid SQS messages to wager-transactions-dlq.fifo after maxReceiveCount=3', async () => {
    const fakeWalletId = randomUUID();
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: mainQueueUrl,
        MessageGroupId: fakeWalletId,
        MessageDeduplicationId: 'bad-json-msg-1',
        MessageBody: '{ "messageId": "bad-1", "broken": true }',
      }),
    );

    const dlqRecord = await waitUntil(
      async () => {
        await consumerService.pollAndProcessOnce();
        const res = await sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: dlqUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 0,
          }),
        );
        return res.Messages?.[0] ?? false;
      },
      { label: 'invalid message moves to DLQ' },
    );

    expect(dlqRecord.Body).toContain('bad-1');
  });

  it('returns visibility for subsequent same-wallet messages in a batch on transient error while processing other wallets in parallel', async () => {
    const walletA = await createWallet(randomUUID(), '100.00');
    const walletB = await createWallet(randomUUID(), '100.00');

    // Enqueue msgA1 (will hit transient failure), msgA2 (same walletA), and msgB1 (walletB)
    await enqueueInboundSqs(walletA.id, {
      messageId: 'msg-a1',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'a1',
        idempotencyKey: 'provider-a:a1',
        playerId: walletA.playerId,
        walletId: walletA.id,
        roundId: 'r-a1',
        gameId: 'g',
        kind: WagerTransactionKind.Bet,
        money: { amount: '20.00', currency: 'BRL' },
      },
    });
    await enqueueInboundSqs(walletA.id, {
      messageId: 'msg-a2',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'a2',
        idempotencyKey: 'provider-a:a2',
        playerId: walletA.playerId,
        walletId: walletA.id,
        roundId: 'r-a2',
        gameId: 'g',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
      },
    });
    await enqueueInboundSqs(walletB.id, {
      messageId: 'msg-b1',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'b1',
        idempotencyKey: 'provider-a:b1',
        playerId: walletB.playerId,
        walletId: walletB.id,
        roundId: 'r-b1',
        gameId: 'g',
        kind: WagerTransactionKind.Bet,
        money: { amount: '15.00', currency: 'BRL' },
      },
    });

    // Hold lock on Wallet A for 3.5s or simulate transient failure on msg-a1 using fault hook
    let failA1 = true;
    consumerService.setFaultHooks({
      beforeProcessMessage: (msg) => {
        if (msg.messageId === 'msg-a1' && failA1) {
          failA1 = false;
          throw new Error('SIMULATED_TRANSIENT_FAILURE');
        }
      },
    });

    // Receive batch manually and pass to processMessageBatch to deterministically test intra-batch behavior
    const batchMessages: Message[] = [];

    await waitUntil(
      async () => {
        const res = await sqsClient.send(
          new ReceiveMessageCommand({
            QueueUrl: mainQueueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 0,
            VisibilityTimeout: 30,
          }),
        );
        batchMessages.push(...(res.Messages ?? []));
        return batchMessages.length >= 3;
      },
      { label: 'receive 3 messages into batch' },
    );

    const summary = await consumerService.processReceivedBatch(batchMessages);
    // Wallet B processed and acked; msg-a1 failed transiently; msg-a2 skipped & visibility returned!
    expect(summary.acked).toBe(1);
    expect(summary.visibilityReturned).toBeGreaterThanOrEqual(1);

    // Verify msg-a2 was NOT processed out of order before msg-a1
    const a2Inbox = await orm.em
      .getConnection()
      .execute<Array<{ message_id: string }>>(
        `SELECT message_id FROM inbox_messages WHERE message_id = 'msg-a2'`,
      );
    expect(a2Inbox).toHaveLength(0);

    // Wallet B was already processed to 85.00
    const wBRow = await orm.em
      .getConnection()
      .execute<Array<{ balance_amount: string }>>(
        'SELECT balance_amount FROM wallets WHERE id = ?',
        [walletB.id],
      );
    expect(wBRow[0]?.balance_amount).toBe('85.00');

    // Now let consumer process remaining Wallet A messages in order (msg-a1 then msg-a2)
    await waitUntil(
      async () => {
        await consumerService.pollAndProcessOnce();
        const rows = await orm.em
          .getConnection()
          .execute<Array<{ message_id: string }>>(
            `SELECT message_id FROM inbox_messages WHERE message_id IN ('msg-a1', 'msg-a2')`,
          );
        return rows.length === 2;
      },
      { label: 'Wallet A completes msg-a1 and msg-a2 after visibility return' },
    );

    const wARow = await orm.em
      .getConnection()
      .execute<Array<{ balance_amount: string }>>(
        'SELECT balance_amount FROM wallets WHERE id = ?',
        [walletA.id],
      );
    expect(wARow[0]?.balance_amount).toBe('70.00');
  });

  it('emits WagerTransactionRejected to outbox when PENDING_REFERENCE exhausts worker attempts', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId, '100.00');

    await enqueueInboundSqs(wallet.id, {
      messageId: 'msg-ooo-exhaust',
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'sqs-ooo-exhaust',
        idempotencyKey: 'provider-a:sqs-ooo-exhaust',
        playerId,
        walletId: wallet.id,
        roundId: 'r-ooo-ex',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Refund,
        money: { amount: '15.00', currency: 'BRL' },
        referenceExternalTransactionId: 'missing-bet',
      },
    });

    await waitUntil(
      async () => {
        await consumerService.pollAndProcessOnce();
        const rows = await orm.em
          .getConnection()
          .execute<Array<{ status: string }>>(
            `SELECT status FROM wager_transactions WHERE external_transaction_id = 'sqs-ooo-exhaust'`,
          );
        return rows[0]?.status === WagerTransactionStatus.PendingReference;
      },
      { label: 'enqueue PENDING_REFERENCE via SQS' },
    );

    let t = Date.now() + 5_000;
    for (let i = 0; i < 6; i++) {
      t += 60_000;
      await pendingWorkerUseCase.processDueBatch({ now: new Date(t), batchSize: 10 });
    }

    const outboxTypes = await orm.em
      .getConnection()
      .execute<Array<{ event_type: string }>>(
        'SELECT event_type FROM outbox_messages ORDER BY occurred_at ASC, id ASC',
      );
    expect(outboxTypes.map((r) => r.event_type)).toContain('WagerTransactionPendingReference');
    expect(outboxTypes.map((r) => r.event_type)).toContain('WagerTransactionRejected');

    const txRow = await orm.em
      .getConnection()
      .execute<Array<{ status: string; failure_code: string }>>(
        `SELECT status, failure_code FROM wager_transactions WHERE external_transaction_id = 'sqs-ooo-exhaust'`,
      );
    expect(txRow[0]).toEqual({
      status: WagerTransactionStatus.Rejected,
      failure_code: FailureCode.ReferenceNotFoundExpired,
    });
  });
});
