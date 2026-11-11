import {
  BalanceLimitExceededError,
  CurrencyMismatchError,
  InsufficientBalanceError,
  InvalidDomainArgumentError,
} from '../errors/domain.error';
import { MAX_MONEY_AMOUNT, type Money } from '../value-objects/money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  now?: Date;
}

export interface WalletBalanceMovement {
  balanceBefore: Money;
  balanceAfter: Money;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (!props.id.trim()) {
      throw new InvalidDomainArgumentError('Wallet id must not be empty');
    }
    if (!props.playerId.trim()) {
      throw new InvalidDomainArgumentError('Wallet playerId must not be empty');
    }
    if (props.initialBalance.isNegative()) {
      throw new InvalidDomainArgumentError('Wallet initialBalance must not be negative');
    }
    if (props.initialBalance.exceedsMaxLimit()) {
      throw new BalanceLimitExceededError(props.id, MAX_MONEY_AMOUNT);
    }

    const now = props.now ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /** Reconstructs aggregate from persisted state without revalidating transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(amount: Money, at: Date = new Date()): WalletBalanceMovement {
    this.assertSameCurrency(amount);
    if (!amount.isPositive()) {
      throw new InvalidDomainArgumentError('Debit amount must be greater than zero');
    }
    if (this._balance.isLessThan(amount)) {
      throw new InsufficientBalanceError(this.id, this._balance.toString(), amount.toString());
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.subtract(amount);
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;

    return { balanceBefore, balanceAfter };
  }

  credit(amount: Money, at: Date = new Date()): WalletBalanceMovement {
    this.assertSameCurrency(amount);
    if (!amount.isPositive()) {
      throw new InvalidDomainArgumentError('Credit amount must be greater than zero');
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(amount);
    if (balanceAfter.exceedsMaxLimit()) {
      throw new BalanceLimitExceededError(this.id, MAX_MONEY_AMOUNT);
    }
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;

    return { balanceBefore, balanceAfter };
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
