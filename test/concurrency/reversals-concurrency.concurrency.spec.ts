import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(30_000);

import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Decimal from 'decimal.js';
import { waitForInfrastructure } from '../../scripts/wait-for-infra';
import { AppModule } from '../../src/app.module';
import {
  type OpenWalletResult,
  ProcessPendingReferencesUseCase,
  type ProcessWagerTransactionResult,
} from '../../src/application/index';
import { FailureCode, WagerTransactionKind } from '../../src/domain/index';

interface ErrorBody {
  statusCode: number;
  errorCode: string;
  message: string;
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

  const seenTx = new Set<string>();
  let reconstructed = new Decimal(0);
  for (const row of ledgerRows) {
    expect(seenTx.has(row.transaction_id)).toBe(false);
    seenTx.add(row.transaction_id);
    const amt = new Decimal(row.amount);
    reconstructed = row.direction === 'CREDIT' ? reconstructed.plus(amt) : reconstructed.minus(amt);
  }

  expect(new Decimal(walletBalance ?? '0').greaterThanOrEqualTo(0)).toBe(true);
  expect(walletBalance).toBe(reconstructed.toFixed(2));
  return walletBalance ?? '0.00';
}

describe('Reversals, PENDING_REFERENCE Workers & Deadlock Stress (Real Postgres)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let orm: MikroORM;
  let pendingWorkerUseCase: ProcessPendingReferencesUseCase;

  beforeAll(async () => {
    await waitForInfrastructure({ silent: true });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');

    const server = app.getHttpServer() as { address: () => { port: number } };
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    orm = app.get(MikroORM);
    pendingWorkerUseCase = app.get(ProcessPendingReferencesUseCase);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    const migrator = orm.getMigrator();
    await migrator.down({ to: 0 });
    await migrator.up();
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

  async function submitTx(idempotencyKey: string, payload: Record<string, unknown>) {
    const res = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    return {
      status: res.status,
      body: (await res.json()) as ProcessWagerTransactionResult & ErrorBody,
    };
  }

  it('allows only 1 of 2 concurrent REFUNDs for the same BET and rejects the other with REFERENCE_ALREADY_REVERSED', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId, '100.00');

    await submitTx('provider-a:bet-c1', {
      providerId: 'provider-a',
      externalTransactionId: 'bet-c1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-c1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '40.00', currency: 'BRL' },
    });

    const [r1, r2] = await Promise.all([
      submitTx('provider-a:refund-c1-a', {
        providerId: 'provider-a',
        externalTransactionId: 'refund-c1-a',
        playerId,
        walletId: wallet.id,
        roundId: 'round-c1',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Refund,
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-c1',
      }),
      submitTx('provider-a:refund-c1-b', {
        providerId: 'provider-a',
        externalTransactionId: 'refund-c1-b',
        playerId,
        walletId: wallet.id,
        roundId: 'round-c1',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Refund,
        money: { amount: '40.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-c1',
      }),
    ]);

    const processed = [r1, r2].filter((r) => r.status === 200);
    const rejected = [r1, r2].filter((r) => r.status === 422);

    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.body.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);

    const finalBal = await assertWalletMatchesLedger(orm, wallet.id);
    expect(finalBal).toBe('100.00');
  });

  it('handles concurrent REFUND and ROLLBACK on the same BET cleanly while preserving ledger consistency', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId, '100.00');

    await submitTx('provider-a:bet-c2', {
      providerId: 'provider-a',
      externalTransactionId: 'bet-c2',
      playerId,
      walletId: wallet.id,
      roundId: 'round-c2',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    });

    const [refundRes, rollbackRes] = await Promise.all([
      submitTx('provider-a:refund-c2', {
        providerId: 'provider-a',
        externalTransactionId: 'refund-c2',
        playerId,
        walletId: wallet.id,
        roundId: 'round-c2',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Refund,
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-c2',
      }),
      submitTx('provider-a:rollback-c2', {
        providerId: 'provider-a',
        externalTransactionId: 'rollback-c2',
        playerId,
        walletId: wallet.id,
        roundId: 'round-c2',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Rollback,
        money: { amount: '30.00', currency: 'BRL' },
        referenceExternalTransactionId: 'bet-c2',
      }),
    ]);

    // Both are distinct reversal kinds (REFUND vs ROLLBACK) -> both succeed cleanly, 70 + 30 + 30 = 130
    expect(refundRes.status).toBe(200);
    expect(rollbackRes.status).toBe(200);

    const finalBal = await assertWalletMatchesLedger(orm, wallet.id);
    expect(finalBal).toBe('130.00');
  });

  it('prevents negative balance when ROLLBACK of WIN races with concurrent BETs consuming balance', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId, '20.00');

    await submitTx('provider-a:win-c4', {
      providerId: 'provider-a',
      externalTransactionId: 'win-c4',
      playerId,
      walletId: wallet.id,
      roundId: 'round-c4',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Win,
      money: { amount: '80.00', currency: 'BRL' },
    });

    // Wallet has 100.00. Fire ROLLBACK(WIN 80) simultaneously with two BETs of 50.00 each
    const [rbWin, betA, betB] = await Promise.all([
      submitTx('provider-a:rb-win-c4', {
        providerId: 'provider-a',
        externalTransactionId: 'rb-win-c4',
        playerId,
        walletId: wallet.id,
        roundId: 'round-c4',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Rollback,
        money: { amount: '80.00', currency: 'BRL' },
        referenceExternalTransactionId: 'win-c4',
      }),
      submitTx('provider-a:bet-c4-a', {
        providerId: 'provider-a',
        externalTransactionId: 'bet-c4-a',
        playerId,
        walletId: wallet.id,
        roundId: 'round-c4-2',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '50.00', currency: 'BRL' },
      }),
      submitTx('provider-a:bet-c4-b', {
        providerId: 'provider-a',
        externalTransactionId: 'bet-c4-b',
        playerId,
        walletId: wallet.id,
        roundId: 'round-c4-3',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '50.00', currency: 'BRL' },
      }),
    ]);

    if (rbWin.status === 422) {
      expect(rbWin.body.failureCode).toBe(FailureCode.ReversalNegativeBalance);
    } else {
      expect(rbWin.status).toBe(200);
      // If ROLLBACK(80) succeeded first (100 -> 20), neither BET(50) could succeed
      expect(betA.status).toBe(422);
      expect(betB.status).toBe(422);
    }

    await assertWalletMatchesLedger(orm, wallet.id);
  });

  it('allows multiple concurrent worker runners on the same PENDING_REFERENCE transactions without duplicating effects', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId, '100.00');

    // Submit 5 out-of-order REFUNDs before their BETs arrive
    for (let i = 0; i < 5; i++) {
      const res = await submitTx(`provider-a:w-ref-${i}`, {
        providerId: 'provider-a',
        externalTransactionId: `w-ref-${i}`,
        playerId,
        walletId: wallet.id,
        roundId: `round-w-${i}`,
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Refund,
        money: { amount: '10.00', currency: 'BRL' },
        referenceExternalTransactionId: `w-bet-${i}`,
      });
      expect(res.status).toBe(202);
    }

    // Submit the 5 BETs
    for (let i = 0; i < 5; i++) {
      const res = await submitTx(`provider-a:w-bet-${i}`, {
        providerId: 'provider-a',
        externalTransactionId: `w-bet-${i}`,
        playerId,
        walletId: wallet.id,
        roundId: `round-w-${i}`,
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: { amount: '10.00', currency: 'BRL' },
      });
      expect(res.status).toBe(200);
    }

    // Run 4 concurrent worker runners against the exact same pending transactions
    const futureNow = new Date(Date.now() + 60_000);
    await Promise.all([
      pendingWorkerUseCase.processDueBatch({ now: futureNow, batchSize: 10 }),
      pendingWorkerUseCase.processDueBatch({ now: futureNow, batchSize: 10 }),
      pendingWorkerUseCase.processDueBatch({ now: futureNow, batchSize: 10 }),
      pendingWorkerUseCase.processDueBatch({ now: futureNow, batchSize: 10 }),
    ]);

    const finalBal = await assertWalletMatchesLedger(orm, wallet.id);
    expect(finalBal).toBe('100.00');

    const conn = orm.em.getConnection();
    const pendingLeft = await conn.execute<Array<{ count: string }>>(
      `SELECT count(*)::text AS count FROM wager_transactions WHERE wallet_id = ? AND status = 'PENDING_REFERENCE'`,
      [wallet.id],
    );
    expect(pendingLeft[0]?.count).toBe('0');

    // Concurrent workers exhausting an orphan PENDING_REFERENCE transition it cleanly to REJECTED (REFERENCE_NOT_FOUND_EXPIRED)
    const orphanRes = await submitTx('provider-a:w-orphan', {
      providerId: 'provider-a',
      externalTransactionId: 'w-orphan',
      playerId,
      walletId: wallet.id,
      roundId: 'round-w-orphan',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: 'missing-forever',
    });
    expect(orphanRes.status).toBe(202);

    let stepNow = Date.now() + 5_000;
    for (let step = 0; step < 6; step++) {
      stepNow += 60_000;
      const tickDate = new Date(stepNow);
      await Promise.all([
        pendingWorkerUseCase.processDueBatch({ now: tickDate, batchSize: 10 }),
        pendingWorkerUseCase.processDueBatch({ now: tickDate, batchSize: 10 }),
      ]);
    }

    const orphanReplay = await submitTx('provider-a:w-orphan', {
      providerId: 'provider-a',
      externalTransactionId: 'w-orphan',
      playerId,
      walletId: wallet.id,
      roundId: 'round-w-orphan',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: 'missing-forever',
    });
    expect(orphanReplay.status).toBe(422);
    expect(orphanReplay.body.failureCode).toBe(FailureCode.ReferenceNotFoundExpired);
    await assertWalletMatchesLedger(orm, wallet.id);
  });

  it('deadlock stress test: concurrent HTTP BET/WIN/REFUND/ROLLBACK traffic alongside 2 parallel workers produces zero deadlocks (40P01)', async () => {
    const wallets = await Promise.all([
      createWallet(randomUUID(), '500.00'),
      createWallet(randomUUID(), '500.00'),
      createWallet(randomUUID(), '500.00'),
    ]);

    // Pre-seed some out-of-order REFUNDs that will resolve as BETs arrive mid-stress
    for (let wIdx = 0; wIdx < wallets.length; wIdx++) {
      const w = wallets[wIdx];
      if (!w) continue;
      for (let i = 0; i < 4; i++) {
        const res = await submitTx(`provider-a:stress-ref-${wIdx}-${i}`, {
          providerId: 'provider-a',
          externalTransactionId: `stress-ref-${wIdx}-${i}`,
          playerId: w.playerId,
          walletId: w.id,
          roundId: `stress-round-${wIdx}-${i}`,
          gameId: 'fortune-chimp',
          kind: WagerTransactionKind.Refund,
          money: { amount: '10.00', currency: 'BRL' },
          referenceExternalTransactionId: `stress-bet-${wIdx}-${i}`,
        });
        expect(res.status).toBe(202);
      }
    }

    // Hammer HTTP + 2 concurrent worker loops simultaneously
    let stopWorkers = false;
    const workerLoop = async () => {
      while (!stopWorkers) {
        await pendingWorkerUseCase.processDueBatch({
          now: new Date(Date.now() + 60_000),
          batchSize: 10,
        });
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    const httpTasks: Array<
      Promise<{ status: number; body: ProcessWagerTransactionResult & ErrorBody }>
    > = [];

    for (let wIdx = 0; wIdx < wallets.length; wIdx++) {
      const w = wallets[wIdx];
      if (!w) continue;
      for (let i = 0; i < 10; i++) {
        httpTasks.push(
          submitTx(`provider-a:stress-bet-${wIdx}-${i}`, {
            providerId: 'provider-a',
            externalTransactionId: `stress-bet-${wIdx}-${i}`,
            playerId: w.playerId,
            walletId: w.id,
            roundId: `stress-round-${wIdx}-${i}`,
            gameId: 'fortune-chimp',
            kind: WagerTransactionKind.Bet,
            money: { amount: '10.00', currency: 'BRL' },
          }),
        );
        httpTasks.push(
          submitTx(`provider-a:stress-win-${wIdx}-${i}`, {
            providerId: 'provider-a',
            externalTransactionId: `stress-win-${wIdx}-${i}`,
            playerId: w.playerId,
            walletId: w.id,
            roundId: `stress-round-${wIdx}-${i}`,
            gameId: 'fortune-chimp',
            kind: WagerTransactionKind.Win,
            money: { amount: '15.00', currency: 'BRL' },
          }),
        );
      }
    }

    const w1 = workerLoop();
    const w2 = workerLoop();
    const httpResponses = await Promise.all(httpTasks);
    stopWorkers = true;
    await Promise.all([w1, w2]);

    // Final worker sweep to ensure all pending references resolved
    await pendingWorkerUseCase.processDueBatch({
      now: new Date(Date.now() + 120_000),
      batchSize: 50,
    });

    for (const res of httpResponses) {
      expect([200, 422]).toContain(res.status);
    }

    for (const w of wallets) {
      await assertWalletMatchesLedger(orm, w.id);
    }
  });
});
