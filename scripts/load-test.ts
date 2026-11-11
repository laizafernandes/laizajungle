import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  GetQueueUrlCommand,
  PurgeQueueCommand,
  type SQSClient,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import type { OpenWalletResult } from '../src/application/index';
import { WagerTransactionKind } from '../src/domain/index';
import { loadEnvConfig } from '../src/infrastructure/config/env.config';
import { SQS_CLIENT_TOKEN } from '../src/infrastructure/messaging/sqs.client';
import { waitForInfrastructure } from './wait-for-infra';

interface WalletSeed {
  id: string;
  playerId: string;
  hot: boolean;
  seedBetExternalId: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number((sorted[index] ?? 0).toFixed(2));
}

async function waitUntil(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

async function runLoadTest(): Promise<void> {
  await waitForInfrastructure({ silent: true });

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');

  try {
    const server = app.getHttpServer() as { address: () => { port: number } };
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const orm = app.get(MikroORM);
    const sqsClient = app.get<SQSClient>(SQS_CLIENT_TOKEN);
    const cfg = loadEnvConfig();

    const migrator = orm.getMigrator();
    await migrator.down({ to: 0 });
    await migrator.up();

    const [mainUrlRes, dlqUrlRes, eventsUrlRes] = await Promise.all([
      sqsClient.send(new GetQueueUrlCommand({ QueueName: cfg.sqs.wagerQueueName })),
      sqsClient.send(new GetQueueUrlCommand({ QueueName: cfg.sqs.wagerDlqName })),
      sqsClient.send(new GetQueueUrlCommand({ QueueName: cfg.sqs.eventsQueueName })),
    ]);

    const mainQueueUrl = mainUrlRes.QueueUrl ?? '';
    await Promise.all([
      sqsClient.send(new PurgeQueueCommand({ QueueUrl: mainQueueUrl })).catch(() => undefined),
      sqsClient
        .send(new PurgeQueueCommand({ QueueUrl: dlqUrlRes.QueueUrl ?? '' }))
        .catch(() => undefined),
      sqsClient
        .send(new PurgeQueueCommand({ QueueUrl: eventsUrlRes.QueueUrl ?? '' }))
        .catch(() => undefined),
    ]);

    const coldWalletCount = Number.parseInt(process.env.LOAD_COLD_WALLETS ?? '30', 10);
    const hotWalletCount = Number.parseInt(process.env.LOAD_HOT_WALLETS ?? '3', 10);
    const totalHttpOps = Number.parseInt(process.env.LOAD_HTTP_OPS ?? '600', 10);
    const httpConcurrency = Number.parseInt(process.env.LOAD_HTTP_CONCURRENCY ?? '24', 10);
    const totalSqsOps = Number.parseInt(process.env.LOAD_SQS_OPS ?? '90', 10);

    const wallets: WalletSeed[] = [];
    for (let i = 0; i < coldWalletCount + hotWalletCount; i++) {
      const isHot = i < hotWalletCount;
      const playerId = randomUUID();
      const openRes = await fetch(`${baseUrl}/wallets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          playerId,
          initialBalance: { amount: isHot ? '2000.00' : '1000.00', currency: 'BRL' },
        }),
      });
      if (openRes.status !== 201) {
        throw new Error(`Failed to open seed wallet: HTTP ${openRes.status}`);
      }
      const created = (await openRes.json()) as OpenWalletResult;

      const seedBetExternalId = `seed-bet-${i}`;
      const seedRes = await fetch(`${baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': `provider-load:${seedBetExternalId}`,
        },
        body: JSON.stringify({
          providerId: 'provider-load',
          externalTransactionId: seedBetExternalId,
          playerId,
          walletId: created.id,
          roundId: `round-seed-${i}`,
          gameId: 'fortune-chimp',
          kind: WagerTransactionKind.Bet,
          money: { amount: '15.00', currency: 'BRL' },
        }),
      });
      if (seedRes.status !== 200) {
        throw new Error(`Failed to create seed BET for wallet ${i}: HTTP ${seedRes.status}`);
      }

      wallets.push({
        id: created.id,
        playerId,
        hot: isHot,
        seedBetExternalId,
      });
    }

    const hotWallets = wallets.slice(0, hotWalletCount);
    const coldWallets = wallets.slice(hotWalletCount);

    interface PlannedHttpOp {
      idempotencyKey: string;
      body: Record<string, unknown>;
    }

    const plannedHttpOps: PlannedHttpOp[] = [];
    const replayCandidates: PlannedHttpOp[] = [];

    for (let i = 0; i < totalHttpOps; i++) {
      const useReplay = i > 20 && i % 5 === 0 && replayCandidates.length > 0;
      if (useReplay) {
        const picked = replayCandidates[i % replayCandidates.length];
        if (picked) {
          plannedHttpOps.push(picked);
          continue;
        }
      }

      // 40% traffic concentrated on hot wallets; 60% distributed across cold wallets
      const targetWallet =
        i % 5 < 2 ? hotWallets[i % hotWallets.length] : coldWallets[i % coldWallets.length];
      if (!targetWallet) {
        continue;
      }

      const mod = i % 10;
      let kind: WagerTransactionKind = WagerTransactionKind.Bet;
      let amount = '12.50';
      let referenceExternalTransactionId: string | undefined;

      if (mod === 3 || mod === 7) {
        kind = WagerTransactionKind.Win;
        amount = '18.00';
      } else if (mod === 9) {
        kind = WagerTransactionKind.Refund;
        amount = '15.00';
        referenceExternalTransactionId = targetWallet.seedBetExternalId;
      }

      const extId = `load-http-${i}`;
      const idempotencyKey = `provider-load:${extId}`;
      const op: PlannedHttpOp = {
        idempotencyKey,
        body: {
          providerId: 'provider-load',
          externalTransactionId: extId,
          playerId: targetWallet.playerId,
          walletId: targetWallet.id,
          roundId:
            kind === WagerTransactionKind.Refund
              ? `round-seed-${wallets.indexOf(targetWallet)}`
              : `round-http-${i}`,
          gameId: 'fortune-chimp',
          kind,
          money: { amount, currency: 'BRL' },
          ...(referenceExternalTransactionId ? { referenceExternalTransactionId } : {}),
        },
      };
      plannedHttpOps.push(op);
      if (kind !== WagerTransactionKind.Refund) {
        replayCandidates.push(op);
      }
    }

    const latenciesMs: number[] = [];
    const statusCounts: Record<number, number> = {};
    let unexpectedFailures = 0;

    // Enqueue SQS batch concurrently with HTTP traffic
    const sqsEnqueuePromise = (async () => {
      for (let i = 0; i < totalSqsOps; i++) {
        const isDuplicate = i > 10 && i % 6 === 0;
        const idx = isDuplicate ? i - 1 : i;
        const w =
          idx % 3 === 0
            ? hotWallets[idx % hotWallets.length]
            : coldWallets[idx % coldWallets.length];
        if (!w) {
          continue;
        }
        const kind = idx % 4 === 0 ? WagerTransactionKind.Win : WagerTransactionKind.Bet;
        const extId = `load-sqs-${idx}`;

        await sqsClient.send(
          new SendMessageCommand({
            QueueUrl: mainQueueUrl,
            MessageGroupId: w.id,
            MessageDeduplicationId: `load-sqs-dedup-${i}`,
            MessageBody: JSON.stringify({
              messageId: `load-sqs-msg-${idx}`,
              type: 'WagerTransactionRequested',
              occurredAt: new Date().toISOString(),
              data: {
                providerId: 'provider-load',
                externalTransactionId: extId,
                idempotencyKey: `provider-load:${extId}`,
                playerId: w.playerId,
                walletId: w.id,
                roundId: `round-sqs-${idx}`,
                gameId: 'fortune-chimp',
                kind,
                money: { amount: '10.00', currency: 'BRL' },
              },
            }),
          }),
        );
      }
    })();

    const loadStartedAt = performance.now();
    let cursor = 0;

    const httpWorkers = Array.from({ length: httpConcurrency }, async () => {
      while (true) {
        const idx = cursor;
        cursor += 1;
        const op = plannedHttpOps[idx];
        if (!op) {
          return;
        }

        const t0 = performance.now();
        try {
          const res = await fetch(`${baseUrl}/wagering/transactions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'Idempotency-Key': op.idempotencyKey,
            },
            body: JSON.stringify(op.body),
          });
          const elapsed = performance.now() - t0;
          latenciesMs.push(elapsed);
          statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1;
          await res.arrayBuffer();

          if (![200, 202, 422, 503].includes(res.status)) {
            unexpectedFailures += 1;
          }
        } catch {
          unexpectedFailures += 1;
        }
      }
    });

    await Promise.all([...httpWorkers, sqsEnqueuePromise]);
    const httpPhaseMs = performance.now() - loadStartedAt;

    // Wait for SQS consumer + Outbox publisher to drain all queued work cleanly
    await waitUntil(
      async () => {
        const sqsDoneRows = await orm.em
          .getConnection()
          .execute<Array<{ cnt: string }>>(
            "SELECT COUNT(*)::text AS cnt FROM inbox_messages WHERE message_id LIKE 'load-sqs-msg-%'",
          );
        const outboxPendingRows = await orm.em
          .getConnection()
          .execute<Array<{ cnt: string }>>(
            'SELECT COUNT(*)::text AS cnt FROM outbox_messages WHERE published_at IS NULL',
          );
        const expectedUniqueSqs = Array.from({ length: totalSqsOps }, (_, idx) => {
          const isDuplicate = idx > 10 && idx % 6 === 0;
          return isDuplicate ? idx - 1 : idx;
        });
        const uniqueCount = new Set(expectedUniqueSqs).size;
        return (
          Number(sqsDoneRows[0]?.cnt ?? 0) >= uniqueCount &&
          Number(outboxPendingRows[0]?.cnt ?? 1) === 0
        );
      },
      30_000,
      'SQS inbox + outbox drain',
    );

    // Post-load invariant verification across ALL wallets
    let consistentWallets = 0;
    for (const wallet of wallets) {
      const reconRes = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
        method: 'POST',
      });
      if (reconRes.status !== 200) {
        throw new Error(`Reconciliation endpoint failed for wallet ${wallet.id}`);
      }
      const recon = (await reconRes.json()) as {
        consistent: boolean;
        difference: { amount: string };
      };
      if (recon.consistent && recon.difference.amount === '0.00') {
        consistentWallets += 1;
      }
    }

    const negRows = await orm.em
      .getConnection()
      .execute<Array<{ cnt: string }>>(
        'SELECT COUNT(*)::text AS cnt FROM wallets WHERE balance_amount < 0',
      );
    const dupLedgerRows = await orm.em
      .getConnection()
      .execute<Array<{ cnt: string }>>(
        'SELECT COUNT(*)::text AS cnt FROM (SELECT wallet_id, transaction_id FROM wallet_ledger_entries GROUP BY wallet_id, transaction_id HAVING COUNT(*) > 1) d',
      );

    const metricsRes = await fetch(`${baseUrl}/metrics?format=json`);
    const metricsJson = (await metricsRes.json()) as {
      outbox: { pendingCount: number; oldestLagMs: number };
      lockConflicts: Record<string, number>;
      duplicates: Record<string, number>;
    };

    const sortedLatencies = [...latenciesMs].sort((a, b) => a - b);
    const report = {
      environment: {
        runtime: `Bun ${Bun.version}`,
        wallets: {
          cold: coldWalletCount,
          hot: hotWalletCount,
          total: wallets.length,
        },
        httpOperations: totalHttpOps,
        httpConcurrency,
        sqsMessagesSubmitted: totalSqsOps,
        dbPoolMax: cfg.db.poolMax,
        dbLockTimeoutMs: cfg.db.lockTimeoutMs,
      },
      results: {
        httpDurationMs: Number(httpPhaseMs.toFixed(2)),
        throughputHttpRps: Number(((totalHttpOps / httpPhaseMs) * 1000).toFixed(2)),
        latencyMs: {
          p50: percentile(sortedLatencies, 50),
          p95: percentile(sortedLatencies, 95),
          p99: percentile(sortedLatencies, 99),
          max: percentile(sortedLatencies, 100),
        },
        httpStatusDistribution: statusCounts,
        lockTimeoutRatePercent: Number(
          (((statusCounts[503] ?? 0) / Math.max(1, totalHttpOps)) * 100).toFixed(2),
        ),
        unexpectedErrors: unexpectedFailures,
        metricsSummary: {
          duplicatesDetected: metricsJson.duplicates,
          lockConflicts: metricsJson.lockConflicts,
          finalOutboxLag: metricsJson.outbox,
        },
      },
      invariants: {
        consistentWallets,
        totalWallets: wallets.length,
        negativeBalanceWallets: Number(negRows[0]?.cnt ?? -1),
        duplicateLedgerEntries: Number(dupLedgerRows[0]?.cnt ?? -1),
        allConsistent:
          consistentWallets === wallets.length &&
          Number(negRows[0]?.cnt ?? 1) === 0 &&
          Number(dupLedgerRows[0]?.cnt ?? 1) === 0 &&
          unexpectedFailures === 0,
      },
    };

    console.log(JSON.stringify(report, null, 2));

    if (!report.invariants.allConsistent) {
      throw new Error('Load test invariant verification failed');
    }
  } finally {
    await app.close();
  }
}

runLoadTest().catch((error) => {
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'load_test_failed',
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }),
  );
  process.exit(1);
});
