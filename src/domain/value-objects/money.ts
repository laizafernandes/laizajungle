import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain.error';

const MoneyDecimal = Decimal.clone({
  precision: 28,
  rounding: Decimal.ROUND_HALF_EVEN,
});

const UNSIGNED_DECIMAL_PATTERN = /^\d+(?:\.\d{1,2})?$/;
const SIGNED_INTERNAL_DECIMAL_PATTERN = /^-?\d+(?:\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Limite máximo compatível com numeric(18,2) no PostgreSQL. */
export const MAX_MONEY_AMOUNT = '9999999999999999.99';
const MAX_MONEY_DECIMAL = new MoneyDecimal(MAX_MONEY_AMOUNT);

export interface MoneyProps {
  amount: string;
  currency: string;
}

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /**
   * Parses an external contract MoneyProps.
   * Rejects negative values, > 2 decimal places, scientific notation, NaN, Infinity, > numeric(18,2), and empty strings.
   */
  static from(props: MoneyProps): Money {
    if (!props || typeof props !== 'object') {
      throw new InvalidMoneyError('Money payload must be an object');
    }

    Money.assertValidCurrency(props.currency);
    Money.assertValidExternalAmount(props.amount);

    const parsed = new MoneyDecimal(props.amount);
    if (!parsed.isFinite()) {
      throw new InvalidMoneyError(`Money amount must be finite: ${props.amount}`);
    }
    if (parsed.greaterThan(MAX_MONEY_DECIMAL)) {
      throw new InvalidMoneyError(`Money amount exceeds maximum allowed (${MAX_MONEY_AMOUNT})`);
    }

    // Normalize -0.00 or 0 to canonical non-negative zero
    const normalized = parsed.isZero() ? new MoneyDecimal(0) : parsed.toDecimalPlaces(2);
    return new Money(normalized, props.currency);
  }

  /**
   * Reconstructs Money from trusted persisted state (supports signed values if ever needed internally).
   */
  static rehydrate(props: MoneyProps): Money {
    Money.assertValidCurrency(props.currency);
    if (typeof props.amount !== 'string' || !SIGNED_INTERNAL_DECIMAL_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(`Invalid persisted money amount: ${String(props.amount)}`);
    }
    const parsed = new MoneyDecimal(props.amount).toDecimalPlaces(2);
    return new Money(parsed.isZero() ? new MoneyDecimal(0) : parsed, props.currency);
  }

  static zero(currency: string): Money {
    Money.assertValidCurrency(currency);
    return new Money(new MoneyDecimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    const sum = this.value.plus(other.value).toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_EVEN);
    return new Money(sum.isZero() ? new MoneyDecimal(0) : sum, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    const diff = this.value.minus(other.value).toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_EVEN);
    return new Money(diff.isZero() ? new MoneyDecimal(0) : diff, this.currency);
  }

  negate(): Money {
    if (this.value.isZero()) {
      return this;
    }
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  exceedsMaxLimit(): boolean {
    return this.value.greaterThan(MAX_MONEY_DECIMAL);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  get amount(): string {
    return this.value.toFixed(2);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.amount,
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertValidCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(
        `Currency must be a 3-letter uppercase ISO-4217 code, received: ${String(currency)}`,
      );
    }
  }

  private static assertValidExternalAmount(amount: unknown): asserts amount is string {
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError(
        `Money amount must be a decimal string (never number), received type ${typeof amount}`,
      );
    }

    if (!UNSIGNED_DECIMAL_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `Invalid money amount "${amount}": expected non-negative decimal string with up to 2 decimal places`,
      );
    }
  }
}
