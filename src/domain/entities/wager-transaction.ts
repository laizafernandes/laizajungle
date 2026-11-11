import {
  type FailureCode,
  LedgerDirection,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../enums/wagering.enums';
import { InvalidDomainArgumentError, InvalidTransactionStateError } from '../errors/domain.error';
import type { Money } from '../value-objects/money';

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  createdAt?: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resultingBalance?: Money;
  referenceAttempts: number;
  nextReferenceRetryAt?: Date;
}

const TERMINAL_STATUSES = new Set<WagerTransactionStatus>([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _resultingBalance?: Money,
    private _referenceAttempts = 0,
    private _nextReferenceRetryAt?: Date,
  ) {}

  /**
   * Creates an external provider transaction starting in PENDING.
   * Rejects internal OPENING kind and enforces reference presence for REFUND/ROLLBACK.
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidDomainArgumentError(
        'WagerTransactionKind.Opening is internal and cannot be created via provider requests',
      );
    }
    if (!props.money.isPositive()) {
      throw new InvalidDomainArgumentError('Transaction money amount must be strictly positive');
    }

    const requiresRef =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;

    if (requiresRef && !props.referenceExternalTransactionId?.trim()) {
      throw new InvalidDomainArgumentError(`${props.kind} requires referenceExternalTransactionId`);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  /** Internal factory used exclusively when opening a wallet with positive initial balance. */
  static createOpening(props: CreateOpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidDomainArgumentError('Opening transaction requires strictly positive amount');
    }
    const createdAt = props.createdAt ?? new Date();
    const externalId = `opening:${props.walletId}`;
    return new WagerTransaction(
      props.id,
      'internal',
      externalId,
      `internal:opening:${props.walletId}`,
      `opening:${props.walletId}:${props.money.amount}:${props.money.currency}`,
      props.walletId,
      props.playerId,
      `opening:${props.walletId}`,
      'wallet-opening',
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  /** Reconstructs persisted transaction state without revalidating transitions. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultingBalance,
      state.referenceAttempts,
      state.nextReferenceRetryAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get resultingBalance(): Money | undefined {
    return this._resultingBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceRetryAt(): Date | undefined {
    return this._nextReferenceRetryAt;
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    resultingBalance?: Money,
  ): void {
    this.assertNonTerminal('PROCESSED');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultingBalance = resultingBalance;
    this._nextReferenceRetryAt = undefined;
  }

  markPendingReference(nextRetryAt?: Date): void {
    this.assertNonTerminal('PENDING_REFERENCE');
    this._status = WagerTransactionStatus.PendingReference;
    this._nextReferenceRetryAt = nextRetryAt;
  }

  scheduleReferenceRetry(nextRetryAt: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        `Cannot schedule reference retry from status ${this._status}`,
      );
    }
    this._referenceAttempts += 1;
    this._nextReferenceRetryAt = nextRetryAt;
  }

  reject(code: FailureCode, at: Date = new Date(), resultingBalance?: Money): void {
    this.assertNonTerminal('REJECTED');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
    this._resultingBalance = resultingBalance;
    this._nextReferenceRetryAt = undefined;
  }

  fail(code: FailureCode, at: Date = new Date()): void {
    this.assertNonTerminal('FAILED');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceRetryAt = undefined;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidDomainArgumentError(
            'ROLLBACK requires resolved reference transaction to determine ledger direction',
          );
        }
        if (reference.kind === WagerTransactionKind.Bet) {
          return LedgerDirection.Credit;
        }
        if (
          reference.kind === WagerTransactionKind.Win ||
          reference.kind === WagerTransactionKind.Refund
        ) {
          return LedgerDirection.Debit;
        }
        throw new InvalidDomainArgumentError(
          `ROLLBACK cannot revert transaction of kind ${reference.kind}`,
        );
      }
      case WagerTransactionKind.Loss:
        throw new InvalidDomainArgumentError(
          'LOSS does not affect balance and has no ledger direction',
        );
    }
  }

  private assertNonTerminal(targetStatus: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot transition WagerTransaction ${this.id} from terminal status ${this._status} to ${targetStatus}`,
      );
    }
  }
}
