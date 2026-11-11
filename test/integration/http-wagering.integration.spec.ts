import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { waitForInfrastructure } from '../../scripts/wait-for-infra';
import { AppModule } from '../../src/app.module';
import type { OpenWalletResult, ProcessWagerTransactionResult } from '../../src/application/index';
import { FailureCode, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/index';

interface ErrorBody {
  statusCode: number;
  errorCode: string;
  message: string;
}

describe('Sprint 2 — HTTP Wagering Flow & Persistent Idempotency (Real Postgres)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let orm: MikroORM;

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
    return { status: res.status, body: (await res.json()) as OpenWalletResult & ErrorBody };
  }

  async function submitTransaction(
    idempotencyKey: string | undefined,
    payload: Record<string, unknown>,
  ) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    const res = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return {
      status: res.status,
      body: (await res.json()) as ProcessWagerTransactionResult & ErrorBody,
    };
  }

  it('opens wallet with OPENING transaction and CREDIT ledger entry when initialBalance > 0, and rejects duplicate player+currency', async () => {
    const playerId = randomUUID();
    const created = await createWallet(playerId, '1000.00');
    expect(created.status).toBe(201);
    expect(created.body.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(created.body.version).toBe(1);

    const conn = orm.em.getConnection();
    const txRows = await conn.execute<Array<{ kind: string; status: string; amount: string }>>(
      'SELECT kind, status, amount FROM wager_transactions WHERE wallet_id = ?',
      [created.body.id],
    );
    expect(txRows).toEqual([{ kind: 'OPENING', status: 'PROCESSED', amount: '1000.00' }]);

    const ledgerRows = await conn.execute<
      Array<{ direction: string; amount: string; balance_before: string; balance_after: string }>
    >(
      'SELECT direction, amount, balance_before, balance_after FROM wallet_ledger_entries WHERE wallet_id = ?',
      [created.body.id],
    );
    expect(ledgerRows).toEqual([
      {
        direction: 'CREDIT',
        amount: '1000.00',
        balance_before: '0.00',
        balance_after: '1000.00',
      },
    ]);

    // Duplicate (playerId, currency) -> 409 Conflict
    const dup = await createWallet(playerId, '50.00');
    expect(dup.status).toBe(409);
    expect(dup.body.errorCode).toBe('WALLET_ALREADY_EXISTS');

    // Zero initial balance creates wallet without OPENING tx or ledger entry
    const zeroPlayer = randomUUID();
    const zeroWallet = await createWallet(zeroPlayer, '0.00');
    expect(zeroWallet.status).toBe(201);
    const zeroTxCount = await conn.execute<Array<{ count: string }>>(
      'SELECT count(*)::text AS count FROM wager_transactions WHERE wallet_id = ?',
      [zeroWallet.body.id],
    );
    expect(zeroTxCount[0]?.count).toBe('0');
  });

  it('processes happy paths for BET, WIN, and LOSS with atomic ledger and balance updates', async () => {
    const playerId = randomUUID();
    const { body: wallet } = await createWallet(playerId, '100.00');

    // BET 25.00 -> 75.00
    const bet = await submitTransaction('provider-a:bet-1', {
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
    expect(bet.body.status).toBe(WagerTransactionStatus.Processed);
    expect(bet.body.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(bet.body.idempotentReplay).toBe(false);

    // WIN 50.00 -> 125.00
    const win = await submitTransaction('provider-a:win-1', {
      providerId: 'provider-a',
      externalTransactionId: 'win-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Win,
      money: { amount: '50.00', currency: 'BRL' },
    });
    expect(win.status).toBe(200);
    expect(win.body.status).toBe(WagerTransactionStatus.Processed);
    expect(win.body.balance).toEqual({ amount: '125.00', currency: 'BRL' });
    expect(win.body.idempotentReplay).toBe(false);

    // LOSS 25.00 -> 125.00 (no balance move, no ledger entry)
    const loss = await submitTransaction('provider-a:loss-1', {
      providerId: 'provider-a',
      externalTransactionId: 'loss-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-2',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Loss,
      money: { amount: '25.00', currency: 'BRL' },
    });
    expect(loss.status).toBe(200);
    expect(loss.body.status).toBe(WagerTransactionStatus.Processed);
    expect(loss.body.balance).toEqual({ amount: '125.00', currency: 'BRL' });
    expect(loss.body.idempotentReplay).toBe(false);

    const conn = orm.em.getConnection();
    const walletRow = await conn.execute<Array<{ balance_amount: string; version: number }>>(
      'SELECT balance_amount, version FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(walletRow[0]).toEqual({ balance_amount: '125.00', version: 3 });

    const ledgerRows = await conn.execute<Array<{ direction: string; amount: string }>>(
      'SELECT direction, amount FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY created_at ASC',
      [wallet.id],
    );
    expect(ledgerRows).toEqual([
      { direction: 'CREDIT', amount: '100.00' },
      { direction: 'DEBIT', amount: '25.00' },
      { direction: 'CREDIT', amount: '50.00' },
    ]);
  });

  it('returns original observed balance on idempotent replay and 409 Conflict on divergent payload or key conflict', async () => {
    const playerId = randomUUID();
    const { body: wallet } = await createWallet(playerId, '100.00');

    const betPayload = {
      providerId: 'provider-a',
      externalTransactionId: 'bet-100',
      playerId,
      walletId: wallet.id,
      roundId: 'round-100',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    };

    const first = await submitTransaction('provider-a:bet-100', betPayload);
    expect(first.status).toBe(200);
    expect(first.body.balance.amount).toBe('75.00');

    // Subsequent WIN moves wallet to 175.00
    await submitTransaction('provider-a:win-100', {
      providerId: 'provider-a',
      externalTransactionId: 'win-100',
      playerId,
      walletId: wallet.id,
      roundId: 'round-100',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Win,
      money: { amount: '100.00', currency: 'BRL' },
    });

    // Replay original BET (even with "25" normalized to "25.00") must return observed 75.00!
    const replay = await submitTransaction('provider-a:bet-100', {
      ...betPayload,
      money: { amount: '25', currency: 'BRL' },
    });
    expect(replay.status).toBe(200);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
    expect(replay.body.status).toBe(WagerTransactionStatus.Processed);
    expect(replay.body.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(replay.body.idempotentReplay).toBe(true);

    // Same Idempotency-Key with different payload -> 409 IDEMPOTENCY_CONFLICT
    const conflict = await submitTransaction('provider-a:bet-100', {
      ...betPayload,
      money: { amount: '30.00', currency: 'BRL' },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.errorCode).toBe('IDEMPOTENCY_CONFLICT');

    // Same (providerId, externalTransactionId) with different Idempotency-Key -> 409 EXTERNAL_TRANSACTION_CONFLICT
    const extConflict = await submitTransaction('provider-a:other-key', betPayload);
    expect(extConflict.status).toBe(409);
    expect(extConflict.body.errorCode).toBe('EXTERNAL_TRANSACTION_CONFLICT');
  });

  it('persists insufficient balance BET as REJECTED (422) without touching balance/ledger and replays identically', async () => {
    const playerId = randomUUID();
    const { body: wallet } = await createWallet(playerId, '50.00');

    const bigBet = {
      providerId: 'provider-a',
      externalTransactionId: 'bet-too-big',
      playerId,
      walletId: wallet.id,
      roundId: 'round-9',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
    };

    const first = await submitTransaction('provider-a:bet-too-big', bigBet);
    expect(first.status).toBe(422);
    expect(first.body.status).toBe(WagerTransactionStatus.Rejected);
    expect(first.body.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(first.body.balance).toEqual({ amount: '50.00', currency: 'BRL' });
    expect(first.body.idempotentReplay).toBe(false);

    // Wallet balance changes later via WIN
    await submitTransaction('provider-a:win-after-reject', {
      providerId: 'provider-a',
      externalTransactionId: 'win-after-reject',
      playerId,
      walletId: wallet.id,
      roundId: 'round-9',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Win,
      money: { amount: '100.00', currency: 'BRL' },
    });

    // Replay of rejected BET still returns 422 REJECTED with INSUFFICIENT_BALANCE and observed 50.00
    const replay = await submitTransaction('provider-a:bet-too-big', bigBet);
    expect(replay.status).toBe(422);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
    expect(replay.body.status).toBe(WagerTransactionStatus.Rejected);
    expect(replay.body.failureCode).toBe(FailureCode.InsufficientBalance);
    expect(replay.body.balance).toEqual({ amount: '50.00', currency: 'BRL' });
    expect(replay.body.idempotentReplay).toBe(true);
  });

  it('validates HTTP contracts and maps WALLET_NOT_FOUND (404), invalid payload (400), and currency mismatch (422)', async () => {
    const playerId = randomUUID();
    const { body: wallet } = await createWallet(playerId, '100.00');

    // Missing Idempotency-Key -> 400
    const noKey = await submitTransaction(undefined, {
      providerId: 'provider-a',
      externalTransactionId: 'tx-1',
      playerId,
      walletId: wallet.id,
      roundId: 'r-1',
      gameId: 'g-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });
    expect(noKey.status).toBe(400);
    expect(noKey.body.errorCode).toBe('INVALID_PAYLOAD');

    // Number money.amount -> 400
    const numericMoney = await submitTransaction('k-num', {
      providerId: 'provider-a',
      externalTransactionId: 'tx-num',
      playerId,
      walletId: wallet.id,
      roundId: 'r-1',
      gameId: 'g-1',
      kind: 'BET',
      money: { amount: 10, currency: 'BRL' },
    });
    expect(numericMoney.status).toBe(400);

    // OPENING submitted via API -> 400
    const openingApi = await submitTransaction('k-open', {
      providerId: 'provider-a',
      externalTransactionId: 'tx-open',
      playerId,
      walletId: wallet.id,
      roundId: 'r-1',
      gameId: 'g-1',
      kind: 'OPENING',
      money: { amount: '10.00', currency: 'BRL' },
    });
    expect(openingApi.status).toBe(400);

    // Missing wallet -> 404 WALLET_NOT_FOUND
    const missingWallet = await submitTransaction('k-missing-wallet', {
      providerId: 'provider-a',
      externalTransactionId: 'tx-missing',
      playerId,
      walletId: randomUUID(),
      roundId: 'r-1',
      gameId: 'g-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    });
    expect(missingWallet.status).toBe(404);
    expect(missingWallet.body.errorCode).toBe('WALLET_NOT_FOUND');

    // Currency mismatch -> 422 REJECTED with CURRENCY_MISMATCH
    const currencyMismatch = await submitTransaction('k-curr-mismatch', {
      providerId: 'provider-a',
      externalTransactionId: 'tx-curr',
      playerId,
      walletId: wallet.id,
      roundId: 'r-1',
      gameId: 'g-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'USD' },
    });
    expect(currencyMismatch.status).toBe(422);
    expect(currencyMismatch.body.status).toBe(WagerTransactionStatus.Rejected);
    expect(currencyMismatch.body.failureCode).toBe(FailureCode.CurrencyMismatch);
  });

  it('handles parallel idempotency race on the same Idempotency-Key with exactly 1 debit and 14 replays', async () => {
    const playerId = randomUUID();
    const { body: wallet } = await createWallet(playerId, '100.00');

    const payload = {
      providerId: 'provider-a',
      externalTransactionId: 'race-bet-1',
      playerId,
      walletId: wallet.id,
      roundId: 'round-race',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
    };

    const concurrency = 15;
    const responses = await Promise.all(
      Array.from({ length: concurrency }, () =>
        submitTransaction('provider-a:race-bet-1', payload),
      ),
    );

    for (const res of responses) {
      if (res.status !== 200) {
        throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      }
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(WagerTransactionStatus.Processed);
      expect(res.body.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    }

    const txIds = new Set(responses.map((r) => r.body.transactionId));
    expect(txIds.size).toBe(1);

    const nonReplays = responses.filter((r) => r.body.idempotentReplay === false);
    const replays = responses.filter((r) => r.body.idempotentReplay === true);
    expect(nonReplays).toHaveLength(1);
    expect(replays).toHaveLength(concurrency - 1);

    const conn = orm.em.getConnection();
    const walletRow = await conn.execute<Array<{ balance_amount: string; version: number }>>(
      'SELECT balance_amount, version FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(walletRow[0]).toEqual({ balance_amount: '75.00', version: 2 });

    const ledgerRows = await conn.execute<Array<{ direction: string; amount: string }>>(
      'SELECT direction, amount FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY created_at ASC',
      [wallet.id],
    );
    expect(ledgerRows).toEqual([
      { direction: 'CREDIT', amount: '100.00' },
      { direction: 'DEBIT', amount: '25.00' },
    ]);
  });
});
