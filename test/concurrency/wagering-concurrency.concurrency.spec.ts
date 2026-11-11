import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(30_000);
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Decimal from 'decimal.js';
import { waitForInfrastructure } from '../../scripts/wait-for-infra';
import { AppModule } from '../../src/app.module';
import type { OpenWalletResult, ProcessWagerTransactionResult } from '../../src/application/index';
import { FailureCode, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/index';

interface ErrorBody {
  statusCode: number;
  errorCode: string;
  message: string;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate ephemeral port')));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function waitForHttpReady(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health/ready`);
      if (res.status === 200) {
        return;
      }
    } catch {
      // keep polling until process binds port
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Instance at ${url} did not become ready within ${timeoutMs}ms`);
}

async function assertWalletMatchesLedger(
  orm: MikroORM,
  walletId: string,
): Promise<{ walletBalance: string; ledgerBalance: string; entryCount: number }> {
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

  // Every transaction produces at most one ledger entry per wallet
  const seenTxIds = new Set<string>();
  let reconstructed = new Decimal(0);

  for (const row of ledgerRows) {
    expect(seenTxIds.has(row.transaction_id)).toBe(false);
    seenTxIds.add(row.transaction_id);

    const amt = new Decimal(row.amount);
    if (row.direction === 'CREDIT') {
      reconstructed = reconstructed.plus(amt);
    } else if (row.direction === 'DEBIT') {
      reconstructed = reconstructed.minus(amt);
    } else {
      throw new Error(`Unexpected ledger direction: ${row.direction}`);
    }
  }

  const ledgerBalance = reconstructed.toFixed(2);
  expect(new Decimal(walletBalance ?? '0').greaterThanOrEqualTo(0)).toBe(true);
  expect(walletBalance).toBe(ledgerBalance);

  return {
    walletBalance: walletBalance ?? '0.00',
    ledgerBalance,
    entryCount: ledgerRows.length,
  };
}

describe('Sprint 3 — Real Concurrency & Per-Wallet Locking (Real Postgres)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let orm: MikroORM;

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

  async function createWallet(
    playerId: string,
    amount: string,
    targetBaseUrl = baseUrl,
  ): Promise<OpenWalletResult> {
    const res = await fetch(`${targetBaseUrl}/wallets`, {
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

  async function submitBetOrWin(
    params: {
      idempotencyKey: string;
      externalTransactionId: string;
      playerId: string;
      walletId: string;
      roundId: string;
      kind: WagerTransactionKind.Bet | WagerTransactionKind.Win;
      amount: string;
    },
    targetBaseUrl = baseUrl,
  ) {
    const res = await fetch(`${targetBaseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': params.idempotencyKey,
      },
      body: JSON.stringify({
        providerId: 'provider-a',
        externalTransactionId: params.externalTransactionId,
        playerId: params.playerId,
        walletId: params.walletId,
        roundId: params.roundId,
        gameId: 'fortune-chimp',
        kind: params.kind,
        money: { amount: params.amount, currency: 'BRL' },
      }),
    });

    return {
      status: res.status,
      body: (await res.json()) as ProcessWagerTransactionResult & ErrorBody,
    };
  }

  it('Scenario 1 (Section 8 mandatory): 100.00 BRL wallet with two parallel 80.00 BRL bets processes 1, rejects 1, ends at 20.00 BRL (repeated 10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      const playerId = randomUUID();
      const wallet = await createWallet(playerId, '100.00');

      const [resA, resB] = await Promise.all([
        submitBetOrWin({
          idempotencyKey: `provider-a:race-80-r${round}-a`,
          externalTransactionId: `race-80-r${round}-a`,
          playerId,
          walletId: wallet.id,
          roundId: `round-80-${round}`,
          kind: WagerTransactionKind.Bet,
          amount: '80.00',
        }),
        submitBetOrWin({
          idempotencyKey: `provider-a:race-80-r${round}-b`,
          externalTransactionId: `race-80-r${round}-b`,
          playerId,
          walletId: wallet.id,
          roundId: `round-80-${round}`,
          kind: WagerTransactionKind.Bet,
          amount: '80.00',
        }),
      ]);

      const results = [resA, resB];
      const processed = results.filter(
        (r) => r.status === 200 && r.body.status === WagerTransactionStatus.Processed,
      );
      const rejected = results.filter(
        (r) => r.status === 422 && r.body.status === WagerTransactionStatus.Rejected,
      );

      expect(processed).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.body.failureCode).toBe(FailureCode.InsufficientBalance);
      expect(processed[0]?.body.balance.amount).toBe('20.00');

      const invariant = await assertWalletMatchesLedger(orm, wallet.id);
      expect(invariant.walletBalance).toBe('20.00');
      // 1 OPENING CREDIT + 1 BET DEBIT
      expect(invariant.entryCount).toBe(2);
    }
  });

  it('Scenario 2: 50 concurrent varied BETs on same wallet never produce negative balance and match ledger exactly', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId, '500.00');

    const betAmounts = Array.from({ length: 50 }, (_, idx) => {
      const value = 15 + (idx % 4) * 5; // 15.00, 20.00, 25.00, 30.00 -> sum > 1000.00
      return `${value}.00`;
    });

    const responses = await Promise.all(
      betAmounts.map((amount, idx) =>
        submitBetOrWin({
          idempotencyKey: `provider-a:varied-bet-${idx}`,
          externalTransactionId: `varied-bet-${idx}`,
          playerId,
          walletId: wallet.id,
          roundId: `round-${idx}`,
          kind: WagerTransactionKind.Bet,
          amount,
        }),
      ),
    );

    let processedSum = new Decimal(0);
    for (let i = 0; i < responses.length; i++) {
      const res = responses[i];
      if (!res) {
        throw new Error('Missing response');
      }
      if (res.status === 200) {
        expect(res.body.status).toBe(WagerTransactionStatus.Processed);
        processedSum = processedSum.plus(new Decimal(betAmounts[i] ?? '0'));
      } else {
        expect(res.status).toBe(422);
        expect(res.body.status).toBe(WagerTransactionStatus.Rejected);
        expect(res.body.failureCode).toBe(FailureCode.InsufficientBalance);
      }
    }

    const expectedFinal = new Decimal('500.00').minus(processedSum).toFixed(2);
    const invariant = await assertWalletMatchesLedger(orm, wallet.id);
    expect(invariant.walletBalance).toBe(expectedFinal);
  });

  it('Scenario 3 (Section 13): same BET sent 50 times in parallel results in a single debit', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId, '100.00');

    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        submitBetOrWin({
          idempotencyKey: 'provider-a:dup-50',
          externalTransactionId: 'dup-50',
          playerId,
          walletId: wallet.id,
          roundId: 'round-dup-50',
          kind: WagerTransactionKind.Bet,
          amount: '25.00',
        }),
      ),
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(WagerTransactionStatus.Processed);
      expect(res.body.balance.amount).toBe('75.00');
    }

    const uniqueTxIds = new Set(responses.map((r) => r.body.transactionId));
    expect(uniqueTxIds.size).toBe(1);
    expect(responses.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(responses.filter((r) => r.body.idempotentReplay === true)).toHaveLength(49);

    const invariant = await assertWalletMatchesLedger(orm, wallet.id);
    expect(invariant.walletBalance).toBe('75.00');
    expect(invariant.entryCount).toBe(2);
  });

  it('Scenario 4: concurrent mix of 20 BETs and 20 WINs on same wallet produces zero lost updates', async () => {
    const playerId = randomUUID();
    const wallet = await createWallet(playerId, '200.00');

    const operations = [
      ...Array.from({ length: 20 }, (_, i) => ({
        kind: WagerTransactionKind.Bet as const,
        id: `mix-bet-${i}`,
        amount: '10.00',
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        kind: WagerTransactionKind.Win as const,
        id: `mix-win-${i}`,
        amount: '15.00',
      })),
    ];

    const responses = await Promise.all(
      operations.map((op) =>
        submitBetOrWin({
          idempotencyKey: `provider-a:${op.id}`,
          externalTransactionId: op.id,
          playerId,
          walletId: wallet.id,
          roundId: 'round-mix',
          kind: op.kind,
          amount: op.amount,
        }),
      ),
    );

    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(WagerTransactionStatus.Processed);
    }

    // 200.00 - (20 * 10.00) + (20 * 15.00) = 300.00
    const invariant = await assertWalletMatchesLedger(orm, wallet.id);
    expect(invariant.walletBalance).toBe('300.00');
    expect(invariant.entryCount).toBe(41);
  });

  it('Scenario 5: different wallets process in parallel without global lock serialization', async () => {
    const walletA = await createWallet(randomUUID(), '100.00');
    const walletB = await createWallet(randomUUID(), '100.00');
    const playerB = walletB.playerId;

    const lockerEm = orm.em.fork();
    await lockerEm.transactional(async (txEm) => {
      // Hold an exclusive row lock on Wallet A in an open SQL transaction
      await txEm.execute('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [walletA.id]);

      const start = performance.now();
      const resB = await submitBetOrWin({
        idempotencyKey: 'provider-a:wallet-b-parallel',
        externalTransactionId: 'wallet-b-parallel',
        playerId: playerB,
        walletId: walletB.id,
        roundId: 'round-b',
        kind: WagerTransactionKind.Bet,
        amount: '25.00',
      });
      const elapsedMs = performance.now() - start;

      expect(resB.status).toBe(200);
      expect(resB.body.balance.amount).toBe('75.00');
      expect(elapsedMs).toBeLessThan(1_000);
    });

    const invB = await assertWalletMatchesLedger(orm, walletB.id);
    expect(invB.walletBalance).toBe('75.00');
  });

  it('Scenario 6 (Section 8 & 13): 3 independent application processes hitting the same wallet concurrently maintain exact consistency', async () => {
    const ports = await Promise.all([getFreePort(), getFreePort(), getFreePort()]);
    const processes = ports.map((port) =>
      Bun.spawn(['bun', 'run', 'src/main.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(port),
        },
        stdout: 'ignore',
        stderr: 'ignore',
      }),
    );

    const urls = ports.map((p) => `http://127.0.0.1:${p}`);

    try {
      await Promise.all(urls.map((u) => waitForHttpReady(u)));

      const playerId = randomUUID();
      const wallet = await createWallet(playerId, '100.00', urls[0]);

      const totalBets = 15;
      const responses = await Promise.all(
        Array.from({ length: totalBets }, (_, idx) => {
          const targetUrl = urls[idx % urls.length];
          return submitBetOrWin(
            {
              idempotencyKey: `provider-a:multi-proc-bet-${idx}`,
              externalTransactionId: `multi-proc-bet-${idx}`,
              playerId,
              walletId: wallet.id,
              roundId: `round-mp-${idx}`,
              kind: WagerTransactionKind.Bet,
              amount: '15.00',
            },
            targetUrl,
          );
        }),
      );

      const processed = responses.filter(
        (r) => r.status === 200 && r.body.status === WagerTransactionStatus.Processed,
      );
      const rejected = responses.filter(
        (r) => r.status === 422 && r.body.status === WagerTransactionStatus.Rejected,
      );

      // 100.00 / 15.00 = 6 bets max (90.00), leaving 10.00 BRL; 9 must be rejected
      expect(processed).toHaveLength(6);
      expect(rejected).toHaveLength(9);

      const invariant = await assertWalletMatchesLedger(orm, wallet.id);
      expect(invariant.walletBalance).toBe('10.00');
      expect(invariant.entryCount).toBe(7);
    } finally {
      for (const proc of processes) {
        proc.kill('SIGTERM');
      }
      await Promise.all(processes.map((proc) => proc.exited));
    }
  });

  it('Scenario 7: lock_timeout returns 503 WALLET_LOCK_TIMEOUT with Retry-After and allows safe retry after lock release', async () => {
    const port = await getFreePort();
    const proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        DB_LOCK_TIMEOUT_MS: '200',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    const timeoutInstanceUrl = `http://127.0.0.1:${port}`;
    try {
      await waitForHttpReady(timeoutInstanceUrl);

      const playerId = randomUUID();
      const wallet = await createWallet(playerId, '100.00', timeoutInstanceUrl);

      const lockerEm = orm.em.fork();
      await lockerEm.transactional(async (txEm) => {
        await txEm.execute('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [wallet.id]);

        const res = await fetch(`${timeoutInstanceUrl}/wagering/transactions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'Idempotency-Key': 'provider-a:lock-timeout-bet',
          },
          body: JSON.stringify({
            providerId: 'provider-a',
            externalTransactionId: 'lock-timeout-bet',
            playerId,
            walletId: wallet.id,
            roundId: 'round-timeout',
            gameId: 'fortune-chimp',
            kind: WagerTransactionKind.Bet,
            money: { amount: '25.00', currency: 'BRL' },
          }),
        });

        expect(res.status).toBe(503);
        expect(res.headers.get('retry-after')).toBe('1');
        const body = (await res.json()) as ErrorBody;
        expect(body.errorCode).toBe('WALLET_LOCK_TIMEOUT');
      });

      // After lock release, retrying with the same Idempotency-Key succeeds cleanly
      const retry = await submitBetOrWin(
        {
          idempotencyKey: 'provider-a:lock-timeout-bet',
          externalTransactionId: 'lock-timeout-bet',
          playerId,
          walletId: wallet.id,
          roundId: 'round-timeout',
          kind: WagerTransactionKind.Bet,
          amount: '25.00',
        },
        timeoutInstanceUrl,
      );

      expect(retry.status).toBe(200);
      expect(retry.body.status).toBe(WagerTransactionStatus.Processed);
      expect(retry.body.balance.amount).toBe('75.00');
      expect(retry.body.idempotentReplay).toBe(false);

      const invariant = await assertWalletMatchesLedger(orm, wallet.id);
      expect(invariant.walletBalance).toBe('75.00');
      expect(invariant.entryCount).toBe(2);
    } finally {
      proc.kill('SIGTERM');
      await proc.exited;
    }
  });
});
