import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { waitForInfrastructure } from '../../scripts/wait-for-infra';
import { AppModule } from '../../src/app.module';
import {
  type OpenWalletResult,
  ProcessPendingReferencesUseCase,
  type ProcessWagerTransactionResult,
} from '../../src/application/index';
import { FailureCode, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/index';

interface ErrorBody {
  statusCode: number;
  errorCode: string;
  message: string;
}

describe('Sprint 4 — Reversals, PENDING_REFERENCE, Queries & Reconciliation (Real Postgres)', () => {
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
    await app.listen(0);

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

  async function createWallet(playerId: string, amount: string, currency = 'BRL') {
    const res = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount, currency },
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

  it('processes REFUND of a BET once, rejects duplicate REFUND, and enforces REFUND/ROLLBACK reference rules', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId, '100.00');

    const bet = await submitTx('provider-a:bet-1', {
      providerId: 'provider-a',
      externalTransactionId: 'bet-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(bet.status).toBe(200);
    expect(bet.body.balance.amount).toBe('75.00');

    // Happy REFUND -> credits 25.00 back to 100.00
    const refund = await submitTx('provider-a:refund-1', {
      providerId: 'provider-a',
      externalTransactionId: 'refund-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-1',
    });
    expect(refund.status).toBe(200);
    expect(refund.body.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.body.balance.amount).toBe('100.00');
    expect(refund.body.idempotentReplay).toBe(false);

    // Second REFUND for same BET with different key -> 422 REFERENCE_ALREADY_REVERSED
    const dupRefund = await submitTx('provider-a:refund-2', {
      providerId: 'provider-a',
      externalTransactionId: 'refund-2',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-1',
    });
    expect(dupRefund.status).toBe(422);
    expect(dupRefund.body.status).toBe(WagerTransactionStatus.Rejected);
    expect(dupRefund.body.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(dupRefund.body.balance.amount).toBe('100.00');

    // ROLLBACK of REFUND -> debits 25.00 back to 75.00
    const rbRefund = await submitTx('provider-a:rb-refund-1', {
      providerId: 'provider-a',
      externalTransactionId: 'rb-refund-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: 'refund-1',
    });
    expect(rbRefund.status).toBe(200);
    expect(rbRefund.body.status).toBe(WagerTransactionStatus.Processed);
    expect(rbRefund.body.balance.amount).toBe('75.00');

    // Mismatch roundId -> 422 REFERENCE_MISMATCH
    const wrongRound = await submitTx('provider-a:rb-wrong-round', {
      providerId: 'provider-a',
      externalTransactionId: 'rb-wrong-round',
      playerId,
      walletId: wallet.id,
      roundId: 'round-OTHER',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-1',
    });
    expect(wrongRound.status).toBe(422);
    expect(wrongRound.body.failureCode).toBe(FailureCode.ReferenceMismatch);

    // Amount mismatch -> 422 REFERENCE_AMOUNT_MISMATCH
    const wrongAmount = await submitTx('provider-a:rb-wrong-amount', {
      providerId: 'provider-a',
      externalTransactionId: 'rb-wrong-amount',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-1',
    });
    expect(wrongAmount.status).toBe(422);
    expect(wrongAmount.body.failureCode).toBe(FailureCode.ReferenceAmountMismatch);

    // WIN + REFUND on WIN -> 422 INVALID_REFERENCE_KIND
    const win = await submitTx('provider-a:win-1', {
      providerId: 'provider-a',
      externalTransactionId: 'win-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Win,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: 'bet-1',
    });
    expect(win.status).toBe(200);
    expect(win.body.balance.amount).toBe('125.00');

    const refundWin = await submitTx('provider-a:refund-win', {
      providerId: 'provider-a',
      externalTransactionId: 'refund-win',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: 'win-1',
    });
    expect(refundWin.status).toBe(422);
    expect(refundWin.body.failureCode).toBe(FailureCode.InvalidReferenceKind);
  });

  it('rejects reversal that would cause negative balance with REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE and replays faithfully', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId, '20.00');

    // WIN 80.00 -> 100.00
    await submitTx('provider-a:win-big', {
      providerId: 'provider-a',
      externalTransactionId: 'win-big',
      playerId,
      walletId: wallet.id,
      roundId: 'round-neg',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Win,
      money: { amount: '80.00', currency: 'BRL' },
    });

    // BET 70.00 -> 30.00
    await submitTx('provider-a:bet-spend', {
      providerId: 'provider-a',
      externalTransactionId: 'bet-spend',
      playerId,
      walletId: wallet.id,
      roundId: 'round-neg-2',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '70.00', currency: 'BRL' },
    });

    // ROLLBACK of WIN 80.00 would produce 30.00 - 80.00 = -50.00 -> REJECTED!
    const rbPayload = {
      providerId: 'provider-a',
      externalTransactionId: 'rb-win-big',
      playerId,
      walletId: wallet.id,
      roundId: 'round-neg',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Rollback,
      money: { amount: '80.00', currency: 'BRL' },
      referenceExternalTransactionId: 'win-big',
    };

    const first = await submitTx('provider-a:rb-win-big', rbPayload);
    expect(first.status).toBe(422);
    expect(first.body.status).toBe(WagerTransactionStatus.Rejected);
    expect(first.body.failureCode).toBe(FailureCode.ReversalNegativeBalance);
    expect(first.body.balance.amount).toBe('30.00');
    expect(first.body.idempotentReplay).toBe(false);

    // Later deposit raises balance to 230.00
    await submitTx('provider-a:win-later', {
      providerId: 'provider-a',
      externalTransactionId: 'win-later',
      playerId,
      walletId: wallet.id,
      roundId: 'round-neg-3',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Win,
      money: { amount: '200.00', currency: 'BRL' },
    });

    // Replay of rejected ROLLBACK must still return REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE with 30.00
    const replay = await submitTx('provider-a:rb-win-big', rbPayload);
    expect(replay.status).toBe(422);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
    expect(replay.body.status).toBe(WagerTransactionStatus.Rejected);
    expect(replay.body.failureCode).toBe(FailureCode.ReversalNegativeBalance);
    expect(replay.body.balance.amount).toBe('30.00');
    expect(replay.body.idempotentReplay).toBe(true);
  });

  it('persists out-of-order REFUND as 202 PENDING_REFERENCE, resolves via worker when BET arrives, and rejects upon exhaustion', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId, '100.00');

    // Out-of-order REFUND arrives before BET
    const refundPayload = {
      providerId: 'provider-a',
      externalTransactionId: 'ooo-refund-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-ooo',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '30.00', currency: 'BRL' },
      referenceExternalTransactionId: 'ooo-bet-1',
    };

    const pendingRes = await submitTx('provider-a:ooo-refund-1', refundPayload);
    expect(pendingRes.status).toBe(202);
    expect(pendingRes.body.status).toBe(WagerTransactionStatus.PendingReference);
    expect(pendingRes.body.idempotentReplay).toBe(false);

    // Replay while still PENDING_REFERENCE returns 202 + idempotentReplay: true
    const pendingReplay = await submitTx('provider-a:ooo-refund-1', refundPayload);
    expect(pendingReplay.status).toBe(202);
    expect(pendingReplay.body.status).toBe(WagerTransactionStatus.PendingReference);
    expect(pendingReplay.body.idempotentReplay).toBe(true);

    // Now BET arrives (100 -> 70)
    const betRes = await submitTx('provider-a:ooo-bet-1', {
      providerId: 'provider-a',
      externalTransactionId: 'ooo-bet-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-ooo',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect(betRes.status).toBe(200);
    expect(betRes.body.balance.amount).toBe('70.00');

    // Worker processes due PENDING_REFERENCE -> resolves REFUND (70 -> 100)
    await pendingWorkerUseCase.processDueBatch({
      now: new Date(Date.now() + 60_000),
      batchSize: 10,
    });

    const resolvedReplay = await submitTx('provider-a:ooo-refund-1', refundPayload);
    expect(resolvedReplay.status).toBe(200);
    expect(resolvedReplay.body.transactionId).toBe(pendingRes.body.transactionId);
    expect(resolvedReplay.body.status).toBe(WagerTransactionStatus.Processed);
    expect(resolvedReplay.body.balance.amount).toBe('100.00');
    expect(resolvedReplay.body.idempotentReplay).toBe(true);

    // Missing reference that never arrives -> exhausts attempts and becomes REJECTED (REFERENCE_NOT_FOUND_EXPIRED)
    const orphanPayload = {
      providerId: 'provider-a',
      externalTransactionId: 'orphan-refund',
      playerId,
      walletId: wallet.id,
      roundId: 'round-orphan',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: 'never-arrives',
    };
    const orphanRes = await submitTx('provider-a:orphan-refund', orphanPayload);
    expect(orphanRes.status).toBe(202);

    // Default maxAttempts = 5; run batches stepping forward in time
    let t = Date.now() + 5_000;
    for (let step = 0; step < 6; step++) {
      t += 60_000;
      await pendingWorkerUseCase.processDueBatch({
        now: new Date(t),
        batchSize: 10,
      });
    }

    const exhaustedReplay = await submitTx('provider-a:orphan-refund', orphanPayload);
    expect(exhaustedReplay.status).toBe(422);
    expect(exhaustedReplay.body.status).toBe(WagerTransactionStatus.Rejected);
    expect(exhaustedReplay.body.failureCode).toBe(FailureCode.ReferenceNotFoundExpired);
  });

  it('serves GET wallet, keyset-paginated GET ledger, GET transaction lookups, and detects corruption in reconciliation', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId, '100.00');

    const bet1 = await submitTx('provider-a:q-bet-1', {
      providerId: 'provider-a',
      externalTransactionId: 'q-bet-1',
      playerId,
      walletId: wallet.id,
      roundId: 'r-q',
      gameId: 'g-q',
      kind: WagerTransactionKind.Bet,
      money: { amount: '20.00', currency: 'BRL' },
    });
    const win1 = await submitTx('provider-a:q-win-1', {
      providerId: 'provider-a',
      externalTransactionId: 'q-win-1',
      playerId,
      walletId: wallet.id,
      roundId: 'r-q',
      gameId: 'g-q',
      kind: WagerTransactionKind.Win,
      money: { amount: '40.00', currency: 'BRL' },
    });

    // GET /wallets/:walletId
    const wRes = await fetch(`${baseUrl}/wallets/${wallet.id}`);
    expect(wRes.status).toBe(200);
    const wBody = (await wRes.json()) as {
      id: string;
      playerId: string;
      balance: { amount: string; currency: string };
      version: number;
    };
    expect(wBody.balance).toEqual({ amount: '120.00', currency: 'BRL' });
    expect(wBody.version).toBe(3);

    // GET /wallets/:walletId/ledger?limit=2 (opaque cursor pagination across 3 entries)
    const page1Res = await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=2`);
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as {
      items: Array<{ id: string; transactionId: string; direction: string }>;
      nextCursor: string | null;
    };
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2Res = await fetch(
      `${baseUrl}/wallets/${wallet.id}/ledger?cursor=${encodeURIComponent(page1.nextCursor ?? '')}&limit=2`,
    );
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as {
      items: Array<{ id: string; transactionId: string; direction: string }>;
      nextCursor: string | null;
    };
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const allIds = [...page1.items, ...page2.items].map((e) => e.id);
    expect(new Set(allIds).size).toBe(3);

    // GET /wagering/transactions/:transactionId
    const txByIdRes = await fetch(`${baseUrl}/wagering/transactions/${bet1.body.transactionId}`);
    expect(txByIdRes.status).toBe(200);
    const txById = (await txByIdRes.json()) as { id: string; externalTransactionId: string };
    expect(txById.externalTransactionId).toBe('q-bet-1');

    // GET /providers/:providerId/wagering/transactions/:externalTransactionId
    const txByExtRes = await fetch(
      `${baseUrl}/providers/provider-a/wagering/transactions/q-win-1`,
    );
    expect(txByExtRes.status).toBe(200);
    const txByExt = (await txByExtRes.json()) as { id: string };
    expect(txByExt.id).toBe(win1.body.transactionId);

    // Consistent reconciliation
    const reconOkRes = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
    });
    expect(reconOkRes.status).toBe(200);
    const reconOk = (await reconOkRes.json()) as {
      walletId: string;
      storedBalance: { amount: string; currency: string };
      calculatedBalance: { amount: string; currency: string };
      difference: { amount: string; currency: string };
      consistent: boolean;
      checkedEntries: number;
    };
    expect(reconOk).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '120.00', currency: 'BRL' },
      calculatedBalance: { amount: '120.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 3,
    });

    // Simulate balance corruption directly in PostgreSQL (ledger remains immutable at 120.00)
    const conn = orm.em.getConnection();
    await conn.execute('UPDATE wallets SET balance_amount = ? WHERE id = ?', ['999.00', wallet.id]);

    const reconDriftRes = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
    });
    expect(reconDriftRes.status).toBe(200);
    const reconDrift = (await reconDriftRes.json()) as typeof reconOk;
    expect(reconDrift).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '999.00', currency: 'BRL' },
      calculatedBalance: { amount: '120.00', currency: 'BRL' },
      difference: { amount: '879.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 3,
    });

    // Also verify negative drift (stored < calculated) and that reconciliation does NOT silently fix DB
    const afterCheck = await conn.execute<Array<{ balance_amount: string }>>(
      'SELECT balance_amount FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(afterCheck[0]?.balance_amount).toBe('999.00');

    await conn.execute('UPDATE wallets SET balance_amount = ? WHERE id = ?', ['10.00', wallet.id]);
    const reconNegRes = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
    });
    expect(reconNegRes.status).toBe(200);
    const reconNeg = (await reconNegRes.json()) as typeof reconOk;
    expect(reconNeg.consistent).toBe(false);
    expect(reconNeg.difference).toEqual({ amount: '-110.00', currency: 'BRL' });
  });
});
