import { describe, expect, it } from 'bun:test';
import { LedgerCursorCodec, PendingReferencePolicy } from '../../src/application/index';
import {
  FailureCode,
  InvalidDomainArgumentError,
  LedgerDirection,
  Money,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/index';

describe('Sprint 4 — Reversal Rules, Backoff Policy & Cursor Codec (Unit)', () => {
  it('computes exponential backoff capped at maxDelayMs and detects exhaustion by attempts or TTL', () => {
    const policy = new PendingReferencePolicy({
      baseDelayMs: 100,
      maxDelayMs: 500,
      maxAttempts: 4,
      ttlMs: 10_000,
    });

    const t0 = new Date('2026-07-29T15:00:00.000Z');
    expect(policy.computeNextRetryAt(0, t0).getTime() - t0.getTime()).toBe(100);
    expect(policy.computeNextRetryAt(1, t0).getTime() - t0.getTime()).toBe(200);
    expect(policy.computeNextRetryAt(2, t0).getTime() - t0.getTime()).toBe(400);
    expect(policy.computeNextRetryAt(3, t0).getTime() - t0.getTime()).toBe(500);

    expect(policy.isExhausted(3, t0, new Date(t0.getTime() + 500))).toBe(false);
    expect(policy.isExhausted(4, t0, new Date(t0.getTime() + 500))).toBe(true);
    expect(policy.isExhausted(1, t0, new Date(t0.getTime() + 10_000))).toBe(true);
  });

  it('determines ledger directions for REFUND and ROLLBACK of BET, WIN, and REFUND', () => {
    const bet = WagerTransaction.create({
      id: 'tx-bet',
      providerId: 'provider-a',
      externalTransactionId: 'bet-1',
      idempotencyKey: 'provider-a:bet-1',
      payloadHash: 'h-bet',
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'r-1',
      gameId: 'g-1',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    bet.markProcessed(undefined, new Date());

    const win = WagerTransaction.create({
      id: 'tx-win',
      providerId: 'provider-a',
      externalTransactionId: 'win-1',
      idempotencyKey: 'provider-a:win-1',
      payloadHash: 'h-win',
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'r-1',
      gameId: 'g-1',
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
    });
    win.markProcessed(undefined, new Date());

    const refund = WagerTransaction.create({
      id: 'tx-refund',
      providerId: 'provider-a',
      externalTransactionId: 'refund-1',
      idempotencyKey: 'provider-a:refund-1',
      payloadHash: 'h-ref',
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'r-1',
      gameId: 'g-1',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'bet-1',
    });
    refund.markProcessed(bet.id, new Date());

    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);

    const rollbackOfWin = WagerTransaction.create({
      id: 'tx-rb-win',
      providerId: 'provider-a',
      externalTransactionId: 'rb-win-1',
      idempotencyKey: 'provider-a:rb-win-1',
      payloadHash: 'h-rbw',
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'r-1',
      gameId: 'g-1',
      kind: WagerTransactionKind.Rollback,
      money: Money.from({ amount: '50.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'win-1',
    });
    expect(rollbackOfWin.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollbackOfWin.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(rollbackOfWin.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);

    const loss = WagerTransaction.create({
      id: 'tx-loss',
      providerId: 'provider-a',
      externalTransactionId: 'loss-1',
      idempotencyKey: 'provider-a:loss-1',
      payloadHash: 'h-loss',
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'r-1',
      gameId: 'g-1',
      kind: WagerTransactionKind.Loss,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    expect(() => rollbackOfWin.ledgerDirectionFor(loss)).toThrow(InvalidDomainArgumentError);
  });

  it('transitions PENDING_REFERENCE to REJECTED with REFERENCE_NOT_FOUND_EXPIRED upon limit exhaustion', () => {
    const refund = WagerTransaction.create({
      id: 'tx-ref-exp',
      providerId: 'provider-a',
      externalTransactionId: 'ref-exp',
      idempotencyKey: 'provider-a:ref-exp',
      payloadHash: 'h',
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'r-1',
      gameId: 'g-1',
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      referenceExternalTransactionId: 'missing-bet',
    });

    const t0 = new Date('2026-07-29T15:00:00.000Z');
    refund.markPendingReference(new Date(t0.getTime() + 100));
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

    refund.scheduleReferenceRetry(new Date(t0.getTime() + 300));
    expect(refund.referenceAttempts).toBe(1);

    refund.reject(FailureCode.ReferenceNotFoundExpired, new Date(t0.getTime() + 1000));
    expect(refund.status).toBe(WagerTransactionStatus.Rejected);
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotFoundExpired);
    expect(refund.isTerminal()).toBe(true);
  });

  it('encodes and decodes opaque keyset cursor and rejects malformed cursors', () => {
    const createdAt = new Date('2026-07-29T15:00:00.123Z');
    const id = '0192f291-27dd-7d3f-8071-5f8685deef37';

    const token = LedgerCursorCodec.encode({ createdAt, id });
    expect(typeof token).toBe('string');
    expect(token.includes(id)).toBe(false);

    const decoded = LedgerCursorCodec.decode(token);
    expect(decoded.id).toBe(id);
    expect(decoded.createdAt.toISOString()).toBe(createdAt.toISOString());

    expect(() => LedgerCursorCodec.decode('not-valid-base64-json!')).toThrow();
  });
});
