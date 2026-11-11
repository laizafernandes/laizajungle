import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from '../../src/domain/index';

describe('Money Value Object (Unit)', () => {
  it('normalizes valid decimal strings to fixed 2 decimal places', () => {
    expect(Money.from({ amount: '25', currency: 'BRL' }).amount).toBe('25.00');
    expect(Money.from({ amount: '25.5', currency: 'BRL' }).amount).toBe('25.50');
    expect(Money.from({ amount: '25.00', currency: 'BRL' }).amount).toBe('25.00');
    expect(Money.from({ amount: '0', currency: 'BRL' }).amount).toBe('0.00');
    expect(Money.zero('USD').toJSON()).toEqual({ amount: '0.00', currency: 'USD' });
  });

  it('performs exact decimal arithmetic without IEEE-754 floating-point drift', () => {
    const a = Money.from({ amount: '0.10', currency: 'BRL' });
    const b = Money.from({ amount: '0.20', currency: 'BRL' });
    const sum = a.add(b);

    expect(sum.amount).toBe('0.30');
    expect(a.amount).toBe('0.10'); // immutable
    expect(b.amount).toBe('0.20'); // immutable

    const hundred = Money.from({ amount: '100.00', currency: 'BRL' });
    const almostHundred = Money.from({ amount: '99.99', currency: 'BRL' });
    expect(hundred.subtract(almostHundred).amount).toBe('0.01');
  });

  it('supports negation, comparisons, equality, and JSON serialization', () => {
    const m = Money.from({ amount: '25.00', currency: 'BRL' });
    const neg = m.negate();

    expect(neg.isNegative()).toBe(true);
    expect(neg.amount).toBe('-25.00');
    expect(m.isPositive()).toBe(true);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').negate().isZero()).toBe(true);

    expect(m.isLessThan(Money.from({ amount: '30.00', currency: 'BRL' }))).toBe(true);
    expect(m.equals(Money.from({ amount: '25', currency: 'BRL' }))).toBe(true);
    expect(m.equals(Money.from({ amount: '25.00', currency: 'USD' }))).toBe(false);
    expect(m.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(m.toString()).toBe('25.00 BRL');
  });

  it('throws CurrencyMismatchError when operating on different currencies', () => {
    const brl = Money.from({ amount: '10.00', currency: 'BRL' });
    const usd = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  it('rejects invalid amounts: NaN, Infinity, scientific notation, empty, >2 decimals, negatives, numbers', () => {
    const invalidAmounts: unknown[] = [
      '',
      ' ',
      'NaN',
      'Infinity',
      '-Infinity',
      '1e2',
      '1E-2',
      '25.001',
      '0.005',
      '-1.00',
      '-0.01',
      '+25.00',
      '25.',
      '.50',
      'abc',
      '25,00',
      '10000000000000000.00',
      25,
      null,
      undefined,
    ];

    for (const bad of invalidAmounts) {
      expect(() => Money.from({ amount: bad as string, currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    }
  });

  it('rejects invalid ISO-4217 currency codes', () => {
    const invalidCurrencies = ['', 'BR', 'BRL1', 'brl', 'Usd', '123'];
    for (const currency of invalidCurrencies) {
      expect(() => Money.from({ amount: '10.00', currency })).toThrow(InvalidMoneyError);
      expect(() => Money.zero(currency)).toThrow(InvalidMoneyError);
    }
  });
});
