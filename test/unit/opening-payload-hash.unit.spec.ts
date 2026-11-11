import { describe, expect, it } from 'bun:test';
import { Money, WagerTransaction } from '../../src/domain/index';

describe('WagerTransaction.createOpening payloadHash', () => {
  it('usa SHA-256 hex de 64 caracteres, determinístico, mesmo para saldos grandes', () => {
    const build = (amount: string, walletId = 'w-1') =>
      WagerTransaction.createOpening({
        id: 't-1',
        walletId,
        playerId: 'p-1',
        money: Money.from({ amount, currency: 'BRL' }),
      });

    const big = build('9999999999999999.99');
    expect(big.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(build('9999999999999999.99').payloadHash).toBe(big.payloadHash);
    expect(build('100.00').payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(build('100.00').payloadHash).not.toBe(build('100.01').payloadHash);
    expect(build('100.00', 'w-2').payloadHash).not.toBe(build('100.00').payloadHash);
  });
});
