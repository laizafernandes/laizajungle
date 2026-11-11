import { LedgerDirection } from '../enums/wagering.enums';
import { CurrencyMismatchError, InvalidDomainArgumentError } from '../errors/domain.error';
import type { Money } from '../value-objects/money';

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt?: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.id.trim()) {
      throw new InvalidDomainArgumentError('Ledger entry id must not be empty');
    }
    if (!props.walletId.trim()) {
      throw new InvalidDomainArgumentError('Ledger entry walletId must not be empty');
    }
    if (!props.transactionId.trim()) {
      throw new InvalidDomainArgumentError('Ledger entry transactionId must not be empty');
    }
    if (!props.money.isPositive()) {
      throw new InvalidDomainArgumentError('Ledger entry amount must be strictly positive');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidDomainArgumentError('Ledger balances must never be negative');
    }
    if (props.money.currency !== props.balanceBefore.currency) {
      throw new CurrencyMismatchError(props.money.currency, props.balanceBefore.currency);
    }
    if (props.money.currency !== props.balanceAfter.currency) {
      throw new CurrencyMismatchError(props.money.currency, props.balanceAfter.currency);
    }

    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt ?? new Date(),
    );

    if (!entry.isBalanced()) {
      throw new InvalidDomainArgumentError(
        `Unbalanced ledger entry for transaction ${props.transactionId}: ${props.balanceBefore.amount} (${props.direction} ${props.money.amount}) != ${props.balanceAfter.amount}`,
      );
    }

    return entry;
  }

  /** Reconstructs immutable ledger entry from persisted state without revalidating. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /** Verifies balanceBefore ± money === balanceAfter. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);

    return expected.equals(this.balanceAfter);
  }
}
