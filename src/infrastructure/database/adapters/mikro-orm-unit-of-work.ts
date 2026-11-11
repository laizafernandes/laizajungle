import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import {
  type TransactionContext,
  TransientInfrastructureError,
  type UnitOfWorkPort,
  WalletLockTimeoutError,
} from '../../../application/index';
import { loadEnvConfig } from '../../config/env.config';

interface PgErrorWithCode {
  code?: string;
  errno?: string;
  cause?: unknown;
  previous?: unknown;
  driverError?: unknown;
}

const TRANSIENT_PG_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  '08000',
  '08003',
  '08006',
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

function extractErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const err = current as PgErrorWithCode;
    const code = err.code ?? err.errno;
    if (code) {
      return code;
    }
    current = err.cause ?? err.previous ?? err.driverError;
  }
  return undefined;
}

export function unwrapEntityManager(tx: TransactionContext): EntityManager {
  return tx as unknown as EntityManager;
}

@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWorkPort {
  private readonly lockTimeoutMs: number;

  constructor(private readonly em: EntityManager) {
    this.lockTimeoutMs = loadEnvConfig().db.lockTimeoutMs;
  }

  async runInTransaction<T>(fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const forkedEm = this.em.fork();
    try {
      return await forkedEm.transactional(async (txEm) => {
        // PostgreSQL default isolation level is READ COMMITTED, which works with FOR UPDATE
        // by waiting and re-evaluating the latest committed row version upon lock release.
        // txEm.execute() uses txEm's active transaction context (unlike getConnection().execute()).
        await txEm.execute(`SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms'`);
        return fn(txEm as unknown as TransactionContext);
      });
    } catch (error) {
      const code = extractErrorCode(error);
      if (code === '55P03') {
        const retryAfterSeconds = Math.max(1, Math.ceil(this.lockTimeoutMs / 1000));
        throw new WalletLockTimeoutError(this.lockTimeoutMs, retryAfterSeconds);
      }
      if (code && TRANSIENT_PG_CODES.has(code)) {
        throw new TransientInfrastructureError(
          error instanceof Error ? error.message : 'Database temporarily unavailable',
          1,
        );
      }
      throw error;
    }
  }
}
