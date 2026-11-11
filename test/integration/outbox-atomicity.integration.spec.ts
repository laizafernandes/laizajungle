import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(30_000);

import { randomUUID } from 'node:crypto';
import {
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { waitForInfrastructure } from '../../scripts/wait-for-infra';
import { AppModule } from '../../src/app.module';
import {
  type OpenWalletResult,
  OutboxPublisherUseCase,
  type TransactionContext,
  UNIT_OF_WORK_PORT,
  type UnitOfWorkPort,
} from '../../src/application/index';
import { loadEnvConfig } from '../../src/infrastructure/config/env.config';
import {
  MikroOrmUnitOfWork,
  unwrapEntityManager,
} from '../../src/infrastructure/database/adapters/mikro-orm-unit-of-work';
import { SQS_CLIENT_TOKEN } from '../../src/infrastructure/messaging/sqs.client';

describe('Atomicidade transacional do Outbox (Postgres e LocalStack reais)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let orm: MikroORM;
  let sqsClient: SQSClient;
  let outboxPublisherUseCase: OutboxPublisherUseCase;
  let eventsQueueUrl: string;
  let failAfterOutboxWrite = false;
  let outboxSeenBeforeCommit = false;

  beforeAll(async () => {
    process.env.SQS_CONSUMER_ENABLED = 'false';
    process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
    process.env.PENDING_REF_WORKER_ENABLED = 'false';
    await waitForInfrastructure({ silent: true });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(UNIT_OF_WORK_PORT)
      .useFactory({
        inject: [EntityManager],
        factory: (em: EntityManager): UnitOfWorkPort => {
          const realUow = new MikroOrmUnitOfWork(em);
          return {
            runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
              return realUow.runInTransaction(async (tx) => {
                const result = await fn(tx);
                if (failAfterOutboxWrite) {
                  failAfterOutboxWrite = false;
                  const rows = (await unwrapEntityManager(tx).execute(
                    `select count(*)::int as n from outbox_messages where payload::text like '%ext-atomicity-fail%'`,
                  )) as Array<{ n: number }>;
                  outboxSeenBeforeCommit = (rows[0]?.n ?? 0) > 0;
                  throw new Error('INJECTED_CRASH_AFTER_OUTBOX_BEFORE_COMMIT');
                }
                return result;
              });
            },
          };
        },
      })
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    const server = app.getHttpServer() as { address: () => { port: number } };
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    orm = app.get(MikroORM);
    sqsClient = app.get<SQSClient>(SQS_CLIENT_TOKEN);
    outboxPublisherUseCase = app.get(OutboxPublisherUseCase);
    const cfg = loadEnvConfig();
    const evtRes = await sqsClient.send(
      new GetQueueUrlCommand({ QueueName: cfg.sqs.eventsQueueName }),
    );
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
    failAfterOutboxWrite = false;
    outboxSeenBeforeCommit = false;
    const migrator = orm.getMigrator();
    await migrator.down({ to: 0 });
    await migrator.up();
    await sqsClient
      .send(new PurgeQueueCommand({ QueueUrl: eventsQueueUrl }))
      .catch(() => undefined);
  });

  it('falha APÓS escrever linha do outbox e ANTES do commit faz rollback total: nenhum evento nem efeito persistem', async () => {
    const playerId = randomUUID();
    const openRes = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount: '100.00', currency: 'BRL' } }),
    });
    expect(openRes.status).toBe(201);
    const wallet = (await openRes.json()) as OpenWalletResult;

    // Publica e drena eventos da abertura para isolar completamente o cenário da aposta.
    await outboxPublisherUseCase.publishDueBatch();
    await sqsClient.send(new PurgeQueueCommand({ QueueUrl: eventsQueueUrl }));

    // Arma a injeção de falha pós-outbox / pré-commit para a próxima transação.
    failAfterOutboxWrite = true;

    const betRes = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': 'idem-atomicity-fail',
        'x-correlation-id': 'corr-atomicity-fail',
      },
      body: JSON.stringify({
        providerId: 'provider-a',
        externalTransactionId: 'ext-atomicity-fail',
        playerId,
        walletId: wallet.id,
        roundId: 'round-atomicity',
        gameId: 'game-atomicity',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      }),
    });

    expect(betRes.status).toBe(500);
    // Garante que a falha realmente ocorreu DEPOIS que o outbox já tinha sido escrito.
    expect(outboxSeenBeforeCommit).toBe(true);

    // 1. Nenhum efeito nem outbox pendente no PostgreSQL
    const em = orm.em.fork();
    const [walletRow] = (await em.execute(
      'select balance_amount::text as balance, version::int as version from wallets where id = ?',
      [wallet.id],
    )) as Array<{ balance: string; version: number }>;
    expect(walletRow).toEqual({ balance: '100.00', version: 1 });

    const [txCount] = (await em.execute(
      'select count(*)::int as n from wager_transactions where external_transaction_id = ?',
      ['ext-atomicity-fail'],
    )) as Array<{ n: number }>;
    expect(txCount?.n).toBe(0);

    const [ledgerCount] = (await em.execute(
      'select count(*)::int as n from wallet_ledger_entries where wallet_id = ?',
      [wallet.id],
    )) as Array<{ n: number }>;
    expect(ledgerCount?.n).toBe(1); // Apenas o OPENING

    const [unpublishedOutboxCount] = (await em.execute(
      'select count(*)::int as n from outbox_messages where published_at is null',
    )) as Array<{ n: number }>;
    expect(unpublishedOutboxCount?.n).toBe(0);

    // 2. Publisher não encontra nem envia nenhum evento para o SQS
    const pubSummary = await outboxPublisherUseCase.publishDueBatch();
    expect(pubSummary.scanned).toBe(0);
    expect(pubSummary.published).toBe(0);

    const sqsRes = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: eventsQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
      }),
    );
    expect(sqsRes.Messages ?? []).toHaveLength(0);
  });
});
