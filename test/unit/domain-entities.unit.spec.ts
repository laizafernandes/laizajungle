import { describe, expect, it } from 'bun:test';
import {
  BalanceLimitExceededError,
  CurrencyMismatchError,
  FailureCode,
  InsufficientBalanceError,
  InvalidDomainArgumentError,
  InvalidTransactionStateError,
  LedgerDirection,
  Money,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  Wallet,
  WalletLedgerEntry,
} from '../../src/domain/index';

describe('Domain Entities Invariants (Unit)', () => {
  it('opens Wallet with version 1 and increments version on debit/credit only', () => {
    const now = new Date('2026-07-29T15:00:00.000Z');
    const wallet = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      now,
    });

    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('100.00');

    const debit = wallet.debit(Money.from({ amount: '25.00', currency: 'BRL' }), now);
    expect(debit.balanceBefore.amount).toBe('100.00');
    expect(debit.balanceAfter.amount).toBe('75.00');
    expect(wallet.version).toBe(2);

    const credit = wallet.credit(Money.from({ amount: '50.00', currency: 'BRL' }), now);
    expect(credit.balanceBefore.amount).toBe('75.00');
    expect(credit.balanceAfter.amount).toBe('125.00');
    expect(wallet.version).toBe(3);
  });

  it('prevents Wallet overdraft and currency mismatch', () => {
    const wallet = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    });

    expect(() => wallet.debit(Money.from({ amount: '80.00', currency: 'BRL' }))).toThrow(
      InsufficientBalanceError,
    );
    expect(() => wallet.debit(Money.from({ amount: '10.00', currency: 'USD' }))).toThrow(
      CurrencyMismatchError,
    );
    expect(() => wallet.credit(Money.from({ amount: '10.00', currency: 'USD' }))).toThrow(
      CurrencyMismatchError,
    );

    const maxWallet = Wallet.open({
      id: 'w-max',
      playerId: 'p-1',
      initialBalance: Money.from({ amount: '9999999999999999.99', currency: 'BRL' }),
    });
    expect(() => maxWallet.credit(Money.from({ amount: '0.01', currency: 'BRL' }))).toThrow(
      BalanceLimitExceededError,
    );
  });

  it('validates WalletLedgerEntry arithmetic and structural immutability', () => {
    const entry = WalletLedgerEntry.create({
      id: 'le-1',
      walletId: 'w-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
      balanceAfter: Money.from({ amount: '75.00', currency: 'BRL' }),
    });

    expect(entry.isBalanced()).toBe(true);

    expect(() =>
      WalletLedgerEntry.create({
        id: 'le-2',
        walletId: 'w-1',
        transactionId: 'tx-2',
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
        balanceBefore: Money.from({ amount: '100.00', currency: 'BRL' }),
        balanceAfter: Money.from({ amount: '80.00', currency: 'BRL' }),
      }),
    ).toThrow(InvalidDomainArgumentError);
  });

  it('enforces WagerTransaction creation rules, state transitions, and reversal directions', () => {
    expect(() =>
      WagerTransaction.create({
        id: 'tx-open',
        providerId: 'provider-a',
        externalTransactionId: 'ext-1',
        idempotencyKey: 'provider-a:ext-1',
        payloadHash: 'hash',
        walletId: 'w-1',
        playerId: 'p-1',
        roundId: 'r-1',
        gameId: 'g-1',
        kind: WagerTransactionKind.Opening,
        money: Money.from({ amount: '10.00', currency: 'BRL' }),
      }),
    ).toThrow(InvalidDomainArgumentError);

    expect(() =>
      WagerTransaction.create({
        id: 'tx-ref',
        providerId: 'provider-a',
        externalTransactionId: 'ext-2',
        idempotencyKey: 'provider-a:ext-2',
        payloadHash: 'hash',
        walletId: 'w-1',
        playerId: 'p-1',
        roundId: 'r-1',
        gameId: 'g-1',
        kind: WagerTransactionKind.Refund,
        money: Money.from({ amount: '10.00', currency: 'BRL' }),
      }),
    ).toThrow(InvalidDomainArgumentError);

    const bet = WagerTransaction.create({
      id: 'tx-bet',
      providerId: 'provider-a',
      externalTransactionId: 'ext-bet',
      idempotencyKey: 'provider-a:ext-bet',
      payloadHash: 'hash-bet',
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'r-1',
      gameId: 'g-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });

    expect(bet.status).toBe(WagerTransactionStatus.Pending);
    expect(bet.affectsBalance()).toBe(true);
    expect(bet.requiresReference()).toBe(false);
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);

    const processedAt = new Date();
    bet.markProcessed(undefined, processedAt, Money.from({ amount: '75.00', currency: 'BRL' }));
    expect(bet.isTerminal()).toBe(true);
    expect(() => bet.reject(FailureCode.InsufficientBalance)).toThrow(InvalidTransactionStateError);
    expect(() => bet.markPendingReference()).toThrow(InvalidTransactionStateError);

    const rollbackOfBet = WagerTransaction.create({
      id: 'tx-rb-bet',
      providerId: 'provider-a',
      externalTransactionId: 'ext-rb-bet',
      idempotencyKey: 'provider-a:ext-rb-bet',
      payloadHash: 'hash-rb',
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'r-1',
      gameId: 'g-1',
      kind: WagerTransactionKind.Rollback,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'ext-bet',
    });

    expect(rollbackOfBet.requiresReference()).toBe(true);
    expect(rollbackOfBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);

    const win = WagerTransaction.create({
      id: 'tx-win',
      providerId: 'provider-a',
      externalTransactionId: 'ext-win',
      idempotencyKey: 'provider-a:ext-win',
      payloadHash: 'hash-win',
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'r-1',
      gameId: 'g-1',
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
    });
    expect(rollbackOfBet.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });
});
