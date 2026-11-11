import { describe, expect, it } from 'bun:test';
import { CanonicalPayloadHasher } from '../../src/application/index';
import { Money, WagerTransactionKind } from '../../src/domain/index';

describe('CanonicalPayloadHasher (Unit)', () => {
  const basePayload = {
    providerId: 'provider-a',
    externalTransactionId: 'tx-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }).toJSON(),
  };

  it('produces identical SHA-256 digest regardless of input amount scale representation (25 vs 25.00)', () => {
    const hashA = CanonicalPayloadHasher.hash(basePayload);
    const hashB = CanonicalPayloadHasher.hash({
      ...basePayload,
      money: Money.from({ amount: '25', currency: 'BRL' }).toJSON(),
    });

    expect(hashA).toBe(hashB);
    expect(hashA).toHaveLength(64);
  });

  it('produces identical canonical JSON with sorted keys and undefined reference normalized to null', () => {
    const json1 = CanonicalPayloadHasher.canonicalJson(basePayload);
    const json2 = CanonicalPayloadHasher.canonicalJson({
      ...basePayload,
      referenceExternalTransactionId: undefined,
    });

    expect(json1).toBe(json2);
    expect(json1.indexOf('"externalTransactionId"')).toBeLessThan(json1.indexOf('"gameId"'));
    expect(json1.indexOf('"gameId"')).toBeLessThan(json1.indexOf('"kind"'));
    expect(json1.indexOf('"kind"')).toBeLessThan(json1.indexOf('"money"'));
  });

  it('changes digest when any business field changes', () => {
    const baseHash = CanonicalPayloadHasher.hash(basePayload);

    expect(
      CanonicalPayloadHasher.hash({
        ...basePayload,
        money: Money.from({ amount: '25.01', currency: 'BRL' }).toJSON(),
      }),
    ).not.toBe(baseHash);

    expect(
      CanonicalPayloadHasher.hash({
        ...basePayload,
        kind: WagerTransactionKind.Win,
      }),
    ).not.toBe(baseHash);

    expect(
      CanonicalPayloadHasher.hash({
        ...basePayload,
        roundId: 'round-2',
      }),
    ).not.toBe(baseHash);

    expect(
      CanonicalPayloadHasher.hash({
        ...basePayload,
        referenceExternalTransactionId: 'bet-001',
      }),
    ).not.toBe(baseHash);
  });
});
