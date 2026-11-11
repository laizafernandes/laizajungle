import { ValidationApplicationError } from '../../../application/index';
import type { MoneyProps, WagerTransactionKind } from '../../../domain/index';

export interface OpenWalletRequestDto {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface SubmitWagerTransactionRequestDto {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function assertRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationApplicationError(`${fieldName} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertMoneyProps(value: unknown, fieldName: string): MoneyProps {
  const obj = assertRecord(value, fieldName);
  if (typeof obj.amount !== 'string') {
    throw new ValidationApplicationError(
      `${fieldName}.amount must be a decimal string (never number)`,
    );
  }
  if (typeof obj.currency !== 'string') {
    throw new ValidationApplicationError(`${fieldName}.currency must be an ISO-4217 string`);
  }
  return {
    amount: obj.amount,
    currency: obj.currency,
  };
}

function assertStringField(obj: Record<string, unknown>, fieldName: string): string {
  const val = obj[fieldName];
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new ValidationApplicationError(`${fieldName} must be a non-empty string`);
  }
  return val;
}

export function parseOpenWalletBody(body: unknown): OpenWalletRequestDto {
  const obj = assertRecord(body, 'body');
  const playerId = assertStringField(obj, 'playerId');
  const initialBalance = assertMoneyProps(obj.initialBalance, 'initialBalance');

  return {
    playerId,
    initialBalance,
  };
}

export function parseSubmitWagerTransactionBody(body: unknown): SubmitWagerTransactionRequestDto {
  const obj = assertRecord(body, 'body');

  const providerId = assertStringField(obj, 'providerId');
  const externalTransactionId = assertStringField(obj, 'externalTransactionId');
  const playerId = assertStringField(obj, 'playerId');
  const walletId = assertStringField(obj, 'walletId');
  const roundId = assertStringField(obj, 'roundId');
  const gameId = assertStringField(obj, 'gameId');
  const kind = assertStringField(obj, 'kind') as WagerTransactionKind;
  const money = assertMoneyProps(obj.money, 'money');

  let referenceExternalTransactionId: string | undefined;
  if (
    obj.referenceExternalTransactionId !== undefined &&
    obj.referenceExternalTransactionId !== null
  ) {
    if (
      typeof obj.referenceExternalTransactionId !== 'string' ||
      obj.referenceExternalTransactionId.trim().length === 0
    ) {
      throw new ValidationApplicationError(
        'referenceExternalTransactionId must be a non-empty string when provided',
      );
    }
    referenceExternalTransactionId = obj.referenceExternalTransactionId;
  }

  return {
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId,
    gameId,
    kind,
    money,
    referenceExternalTransactionId,
  };
}

export function parseLedgerLimitQuery(rawLimit: string | undefined): number {
  if (rawLimit === undefined || rawLimit.trim().length === 0) {
    return 50;
  }
  if (!/^\d+$/.test(rawLimit.trim())) {
    throw new ValidationApplicationError('limit must be an integer between 1 and 100');
  }
  const parsed = Number.parseInt(rawLimit.trim(), 10);
  if (parsed < 1 || parsed > 100) {
    throw new ValidationApplicationError('limit must be an integer between 1 and 100');
  }
  return parsed;
}
