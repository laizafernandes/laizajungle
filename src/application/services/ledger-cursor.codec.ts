import { ValidationApplicationError } from '../errors/application.error';
import { isValidUuid } from './validation.helpers';

export interface LedgerCursor {
  createdAt: Date;
  id: string;
}

interface RawCursorPayload {
  t?: unknown;
  id?: unknown;
}

export class LedgerCursorCodec {
  static encode(cursor: LedgerCursor): string {
    const json = JSON.stringify({
      t: cursor.createdAt.toISOString(),
      id: cursor.id,
    });
    return Buffer.from(json, 'utf8').toString('base64url');
  }

  static decode(token: string): LedgerCursor {
    if (!token || token.trim().length === 0) {
      throw new ValidationApplicationError('Ledger cursor must not be empty');
    }

    try {
      const json = Buffer.from(token, 'base64url').toString('utf8');
      const parsed = JSON.parse(json) as RawCursorPayload;

      if (typeof parsed.t !== 'string' || !isValidUuid(parsed.id)) {
        throw new Error('Malformed cursor fields');
      }

      const createdAt = new Date(parsed.t);
      if (Number.isNaN(createdAt.getTime())) {
        throw new Error('Invalid cursor timestamp');
      }

      return { createdAt, id: parsed.id };
    } catch {
      throw new ValidationApplicationError('Invalid ledger cursor');
    }
  }
}
