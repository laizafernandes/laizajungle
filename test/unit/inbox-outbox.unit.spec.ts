import { describe, expect, it } from 'bun:test';
import {
  FailureCode,
  InboxMessage,
  InvalidDomainArgumentError,
  LedgerDirection,
  Money,
  OutboxMessage,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  Wallet,
  WalletBalanceChanged,
  WalletLedgerEntry,
} from '../../src/domain/index';

describe('Sprint 5 — InboxMessage, OutboxMessage & IntegrationEvent (Unit)', () => {
  it('validates InboxMessage lifecycle and payloadHash matching', () => {
    expect(() =>
      InboxMessage.receive({
        messageId: ' ',
        consumerName: 'consumer-a',
        payloadHash: 'hash',
      }),
    ).toThrow(InvalidDomainArgumentError);

    const msg = InboxMessage.receive({
      messageId: 'msg-1',
      consumerName: 'wager-transactions-consumer',
      payloadHash: 'abc123',
      receivedAt: new Date('2026-07-29T15:00:00.000Z'),
    });

    expect(msg.isProcessed()).toBe(false);
    expect(msg.matchesPayload('abc123')).toBe(true);
    expect(msg.matchesPayload('different')).toBe(false);

    const processedAt = new Date('2026-07-29T15:00:01.000Z');
    msg.markProcessed(processedAt);
    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt).toEqual(processedAt);
  });

  it('serializes concrete IntegrationEvent subclasses with MoneyProps strings and enqueues OutboxMessage with backoff', () => {
    const now = new Date('2026-07-29T15:00:00.000Z');
    const wallet = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      now,
    });
    const movement = wallet.debit(Money.from({ amount: '25.00', currency: 'BRL' }), now);

    const tx = WagerTransaction.create({
      id: 'tx-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'provider-a:ext-1',
      payloadHash: 'hash-1',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      createdAt: now,
    });
    tx.markProcessed(undefined, now, movement.balanceAfter);

    const entry = WalletLedgerEntry.create({
      id: 'le-1',
      walletId: wallet.id,
      transactionId: tx.id,
      direction: LedgerDirection.Debit,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      balanceBefore: movement.balanceBefore,
      balanceAfter: movement.balanceAfter,
      createdAt: now,
    });

    const ctx = {
      eventId: 'evt-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: now,
    };

    const balanceEvent = WalletBalanceChanged.from(wallet, entry, ctx);
    expect(balanceEvent.eventType).toBe('WalletBalanceChanged');
    expect(balanceEvent.version).toBe(1);
    expect(balanceEvent.toJSON()).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'w-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-07-29T15:00:00.000Z',
      version: 1,
      data: {
        walletId: 'w-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });

    const processedEvent = WagerTransactionProcessed.from(tx, movement.balanceAfter.toJSON(), ctx);
    expect(processedEvent.eventType).toBe('WagerTransactionProcessed');
    expect(processedEvent.version).toBe(1);

    const rejectedEvent = WagerTransactionRejected.from(
      tx,
      FailureCode.InsufficientBalance,
      movement.balanceAfter.toJSON(),
      ctx,
    );
    expect(rejectedEvent.eventType).toBe('WagerTransactionRejected');
    expect(rejectedEvent.data.failureCode).toBe(FailureCode.InsufficientBalance);

    const pendingEvent = WagerTransactionPendingReference.from(tx, now, ctx);
    expect(pendingEvent.eventType).toBe('WagerTransactionPendingReference');

    const outbox = OutboxMessage.enqueue(balanceEvent);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(now)).toBe(true);

    outbox.scheduleRetry(now, 500, 2000);
    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt?.getTime()).toBe(now.getTime() + 500);
    expect(outbox.isDue(now)).toBe(false);
    expect(outbox.isDue(new Date(now.getTime() + 500))).toBe(true);

    outbox.scheduleRetry(now, 500, 2000);
    expect(outbox.attempts).toBe(2);
    expect(outbox.nextAttemptAt?.getTime()).toBe(now.getTime() + 1000);

    outbox.markPublished(new Date(now.getTime() + 1500));
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(new Date(now.getTime() + 2000))).toBe(false);
  });
});
