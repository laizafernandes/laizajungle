import { createHash } from 'node:crypto';
import type { MoneyProps, WagerTransactionKind } from '../../domain/index';

export interface CanonicalTransactionPayload {
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

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        sorted[key] = canonicalizeValue(entry);
      }
    }
    return sorted;
  }
  return value;
}

/**
 * Generates a deterministic SHA-256 hex digest over sorted-key canonical JSON
 * of the business payload subset (excluding Idempotency-Key and transport metadata).
 */
export class CanonicalPayloadHasher {
  static canonicalJson(payload: CanonicalTransactionPayload): string {
    const businessSubset: Record<string, unknown> = {
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      playerId: payload.playerId,
      walletId: payload.walletId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind,
      money: {
        amount: payload.money.amount,
        currency: payload.money.currency,
      },
      referenceExternalTransactionId: payload.referenceExternalTransactionId ?? null,
    };

    return JSON.stringify(canonicalizeValue(businessSubset));
  }

  static hash(payload: CanonicalTransactionPayload): string {
    const canonical = CanonicalPayloadHasher.canonicalJson(payload);
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }
}
