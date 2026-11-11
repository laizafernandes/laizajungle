import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { waitForInfrastructure } from '../../scripts/wait-for-infra';
import {
  FailureCode,
  LedgerDirection,
  Money,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  Wallet,
  WalletLedgerEntry,
} from '../../src/domain/index';
import { WagerTransactionOrmEntity } from '../../src/infrastructure/database/entities/wager-transaction.orm-entity';
import { WalletLedgerEntryOrmEntity } from '../../src/infrastructure/database/entities/wallet-ledger-entry.orm-entity';
import { WalletOrmEntity } from '../../src/infrastructure/database/entities/wallet.orm-entity';
import { WageringMapper } from '../../src/infrastructure/database/mappers/wagering.mapper';
import { buildMikroOrmOptions } from '../../src/infrastructure/database/mikro-orm.config';

interface PgErrorShape {
  code?: string;
  constraint?: string;
  message?: string;
}

async function expectPgError(
  fn: () => Promise<unknown>,
  expectedCode?: string,
  expectedText?: string,
): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeDefined();
  const pgErr = caught as PgErrorShape;
  if (expectedCode) {
    expect(pgErr.code).toBe(expectedCode);
  }
  if (expectedText) {
    const combined = `${pgErr.message ?? ''} ${pgErr.constraint ?? ''}`;
    expect(combined).toContain(expectedText);
  }
}

describe('PostgreSQL Schema Constraints, Trigger & Migration Reversibility', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    await waitForInfrastructure({ silent: true });
    orm = await MikroORM.init(buildMikroOrmOptions());
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
  });

  beforeEach(async () => {
    const migrator = orm.getMigrator();
    await migrator.down({ to: 0 });
    await migrator.up();
  });

  it('supports reversible migrations (up -> down -> up)', async () => {
    const migrator = orm.getMigrator();
    const conn = orm.em.getConnection();

    const tablesBeforeDown = await conn.execute<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('wallets', 'wager_transactions', 'wallet_ledger_entries') ORDER BY table_name`,
    );
    expect(tablesBeforeDown.map((r) => r.table_name)).toEqual([
      'wager_transactions',
      'wallet_ledger_entries',
      'wallets',
    ]);

    await migrator.down({ to: 0 });
    const tablesAfterDown = await conn.execute<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('wallets', 'wager_transactions', 'wallet_ledger_entries')`,
    );
    expect(tablesAfterDown).toHaveLength(0);

    await migrator.up();
    const tablesAfterUp = await conn.execute<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('wallets', 'wager_transactions', 'wallet_ledger_entries')`,
    );
    expect(tablesAfterUp).toHaveLength(3);
  });

  it('persists and rehydrates Wallet, WagerTransaction, and WalletLedgerEntry with exact string numeric(18,2)', async () => {
    const em = orm.em.fork();
    const playerId = randomUUID();
    const walletId = randomUUID();
    const txId = randomUUID();
    const entryId = randomUUID();

    const wallet = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const movement = wallet.debit(Money.from({ amount: '25.50', currency: 'BRL' }));

    const tx = WagerTransaction.create({
      id: txId,
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'provider-a:ext-1',
      payloadHash: 'abc123',
      walletId,
      playerId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '25.50', currency: 'BRL' }),
    });
    tx.markProcessed(undefined, new Date(), movement.balanceAfter);

    const ledger = WalletLedgerEntry.create({
      id: entryId,
      walletId,
      transactionId: txId,
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '25.50', currency: 'BRL' }),
      balanceBefore: movement.balanceBefore,
      balanceAfter: movement.balanceAfter,
    });

    await em.persistAndFlush([
      WageringMapper.walletToOrm(wallet),
      WageringMapper.transactionToOrm(tx),
      WageringMapper.ledgerEntryToOrm(ledger),
    ]);
    em.clear();

    const loadedWalletOrm = await em.findOneOrFail(WalletOrmEntity, { id: walletId });
    const loadedTxOrm = await em.findOneOrFail(WagerTransactionOrmEntity, { id: txId });
    const loadedLedgerOrm = await em.findOneOrFail(WalletLedgerEntryOrmEntity, { id: entryId });

    expect(typeof loadedWalletOrm.balanceAmount).toBe('string');
    expect(typeof loadedTxOrm.amount).toBe('string');
    expect(typeof loadedLedgerOrm.balanceAfter).toBe('string');

    const rehydratedWallet = WageringMapper.walletToDomain(loadedWalletOrm);
    const rehydratedTx = WageringMapper.transactionToDomain(loadedTxOrm);
    const rehydratedLedger = WageringMapper.ledgerEntryToDomain(loadedLedgerOrm);

    expect(rehydratedWallet.balance.amount).toBe('74.50');
    expect(rehydratedWallet.version).toBe(2);
    expect(rehydratedTx.status).toBe(WagerTransactionStatus.Processed);
    expect(rehydratedTx.resultingBalance?.amount).toBe('74.50');
    expect(rehydratedLedger.isBalanced()).toBe(true);
    expect(rehydratedLedger.balanceAfter.amount).toBe('74.50');
  });

  it('enforces wallets constraints: unique (player_id, currency), balance >= 0, version >= 1', async () => {
    const conn = orm.em.getConnection();
    const playerId = randomUUID();
    const wallet1 = randomUUID();
    const wallet2 = randomUUID();

    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES (?, ?, 'BRL', '100.00', 1)`,
      [wallet1, playerId],
    );

    // Duplicate (player_id, currency)
    await expectPgError(
      () =>
        conn.execute(
          `INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES (?, ?, 'BRL', '50.00', 1)`,
          [wallet2, playerId],
        ),
      '23505',
      'uq_wallets_player_currency',
    );

    // Negative balance
    await expectPgError(
      () =>
        conn.execute(
          `INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES (?, ?, 'USD', '-0.01', 1)`,
          [wallet2, playerId],
        ),
      '23514',
      'chk_wallets_balance_non_negative',
    );

    // Non-positive version
    await expectPgError(
      () =>
        conn.execute(
          `INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES (?, ?, 'EUR', '10.00', 0)`,
          [wallet2, playerId],
        ),
      '23514',
      'chk_wallets_version_positive',
    );
  });

  it('enforces wager_transactions constraints: provider+external unique, idempotency unique, amount > 0, required reference, single reversal per kind', async () => {
    const conn = orm.em.getConnection();
    const playerId = randomUUID();
    const walletId = randomUUID();
    const betId = randomUUID();

    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES (?, ?, 'BRL', '100.00', 1)`,
      [walletId, playerId],
    );

    await conn.execute(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status)
       VALUES (?, 'provider-a', 'bet-1', 'key-bet-1', 'hash-1', ?, ?, 'r-1', 'g-1', 'BET', '25.00', 'BRL', 'PROCESSED')`,
      [betId, walletId, playerId],
    );

    // Duplicate (provider_id, external_transaction_id)
    await expectPgError(
      () =>
        conn.execute(
          `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status)
           VALUES (?, 'provider-a', 'bet-1', 'key-bet-1-other', 'hash-1', ?, ?, 'r-1', 'g-1', 'BET', '25.00', 'BRL', 'PENDING')`,
          [randomUUID(), walletId, playerId],
        ),
      '23505',
      'uq_wager_tx_provider_external',
    );

    // Duplicate idempotency_key
    await expectPgError(
      () =>
        conn.execute(
          `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status)
           VALUES (?, 'provider-a', 'bet-2', 'key-bet-1', 'hash-2', ?, ?, 'r-1', 'g-1', 'BET', '25.00', 'BRL', 'PENDING')`,
          [randomUUID(), walletId, playerId],
        ),
      '23505',
      'uq_wager_tx_idempotency_key',
    );

    // amount <= 0
    await expectPgError(
      () =>
        conn.execute(
          `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status)
           VALUES (?, 'provider-a', 'bet-zero', 'key-bet-zero', 'hash-z', ?, ?, 'r-1', 'g-1', 'BET', '0.00', 'BRL', 'PENDING')`,
          [randomUUID(), walletId, playerId],
        ),
      '23514',
      'chk_wager_tx_amount_positive',
    );

    // REFUND without reference_external_transaction_id
    await expectPgError(
      () =>
        conn.execute(
          `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status)
           VALUES (?, 'provider-a', 'ref-no-ext', 'key-ref-no-ext', 'hash-r0', ?, ?, 'r-1', 'g-1', 'REFUND', '25.00', 'BRL', 'PENDING')`,
          [randomUUID(), walletId, playerId],
        ),
      '23514',
      'chk_wager_tx_reference_required',
    );

    // First PROCESSED REFUND succeeds
    await conn.execute(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status)
       VALUES (?, 'provider-a', 'refund-1', 'key-refund-1', 'hash-r1', ?, ?, 'r-1', 'g-1', 'REFUND', '25.00', 'BRL', 'bet-1', ?, 'PROCESSED')`,
      [randomUUID(), walletId, playerId, betId],
    );

    // Second PROCESSED REFUND for same reference is rejected by partial unique index
    await expectPgError(
      () =>
        conn.execute(
          `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status)
           VALUES (?, 'provider-a', 'refund-2', 'key-refund-2', 'hash-r2', ?, ?, 'r-1', 'g-1', 'REFUND', '25.00', 'BRL', 'bet-1', ?, 'PROCESSED')`,
          [randomUUID(), walletId, playerId, betId],
        ),
      '23505',
      'uq_wager_tx_single_reversal_per_kind',
    );

    // REJECTED second attempt remains auditable (not blocked by partial unique index)
    await conn.execute(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code)
       VALUES (?, 'provider-a', 'refund-2-rej', 'key-refund-2-rej', 'hash-r2', ?, ?, 'r-1', 'g-1', 'REFUND', '25.00', 'BRL', 'bet-1', ?, 'REJECTED', ?)`,
      [randomUUID(), walletId, playerId, betId, FailureCode.ReferenceAlreadyReversed],
    );

    // First PROCESSED ROLLBACK on same BET succeeds (different reversal kind), second fails
    await conn.execute(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status)
       VALUES (?, 'provider-a', 'rb-1', 'key-rb-1', 'hash-rb1', ?, ?, 'r-1', 'g-1', 'ROLLBACK', '25.00', 'BRL', 'bet-1', ?, 'PROCESSED')`,
      [randomUUID(), walletId, playerId, betId],
    );

    await expectPgError(
      () =>
        conn.execute(
          `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status)
           VALUES (?, 'provider-a', 'rb-2', 'key-rb-2', 'hash-rb2', ?, ?, 'r-1', 'g-1', 'ROLLBACK', '25.00', 'BRL', 'bet-1', ?, 'PROCESSED')`,
          [randomUUID(), walletId, playerId, betId],
        ),
      '23505',
      'uq_wager_tx_single_reversal_per_kind',
    );
  });

  it('enforces wallet_ledger_entries constraints and immutability trigger (no UPDATE, no DELETE)', async () => {
    const conn = orm.em.getConnection();
    const playerId = randomUUID();
    const walletId = randomUUID();
    const txId1 = randomUUID();
    const txId2 = randomUUID();
    const entryId1 = randomUUID();

    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version) VALUES (?, ?, 'BRL', '100.00', 1)`,
      [walletId, playerId],
    );
    await conn.execute(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status)
       VALUES (?, 'provider-a', 'tx-1', 'key-tx-1', 'h1', ?, ?, 'r-1', 'g-1', 'BET', '25.00', 'BRL', 'PROCESSED'),
              (?, 'provider-a', 'tx-2', 'key-tx-2', 'h2', ?, ?, 'r-1', 'g-1', 'WIN', '50.00', 'BRL', 'PROCESSED')`,
      [txId1, walletId, playerId, txId2, walletId, playerId],
    );

    // Valid DEBIT entry
    await conn.execute(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
       VALUES (?, ?, ?, 'DEBIT', '25.00', 'BRL', '100.00', '75.00')`,
      [entryId1, walletId, txId1],
    );

    // Duplicate (wallet_id, transaction_id)
    await expectPgError(
      () =>
        conn.execute(
          `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
           VALUES (?, ?, ?, 'DEBIT', '25.00', 'BRL', '100.00', '75.00')`,
          [randomUUID(), walletId, txId1],
        ),
      '23505',
      'uq_ledger_wallet_transaction',
    );

    // Negative balance_after
    await expectPgError(
      () =>
        conn.execute(
          `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
           VALUES (?, ?, ?, 'DEBIT', '50.00', 'BRL', '10.00', '-40.00')`,
          [randomUUID(), walletId, txId2],
        ),
      '23514',
      'chk_ledger_balance_after_non_negative',
    );

    // Arithmetic mismatch on CREDIT
    await expectPgError(
      () =>
        conn.execute(
          `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
           VALUES (?, ?, ?, 'CREDIT', '50.00', 'BRL', '75.00', '100.00')`,
          [randomUUID(), walletId, txId2],
        ),
      '23514',
      'chk_ledger_arithmetic',
    );

    // Arithmetic mismatch on DEBIT
    await expectPgError(
      () =>
        conn.execute(
          `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after)
           VALUES (?, ?, ?, 'DEBIT', '50.00', 'BRL', '75.00', '30.00')`,
          [randomUUID(), walletId, txId2],
        ),
      '23514',
      'chk_ledger_arithmetic',
    );

    // Trigger blocks UPDATE
    await expectPgError(
      () =>
        conn.execute(`UPDATE wallet_ledger_entries SET amount = '999.00' WHERE id = ?`, [entryId1]),
      '23001',
      'append-only and immutable',
    );

    // Trigger blocks DELETE
    await expectPgError(
      () => conn.execute('DELETE FROM wallet_ledger_entries WHERE id = ?', [entryId1]),
      '23001',
      'append-only and immutable',
    );
  });
});
