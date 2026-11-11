import { describe, expect, it } from 'bun:test';
import { loadEnvConfig } from '../../src/infrastructure/config/env.config';

describe('Environment Configuration (Unit)', () => {
  it('loads default values matching .env.example when env vars are omitted', () => {
    const config = loadEnvConfig({});
    expect(config.port).toBe(3000);
    expect(config.db.host).toBe('127.0.0.1');
    expect(config.db.port).toBe(5432);
    expect(config.db.name).toBe('jungle_wagering');
    expect(config.db.poolMin).toBe(2);
    expect(config.db.poolMax).toBe(20);
    expect(config.db.lockTimeoutMs).toBe(3000);
    expect(config.sqs.wagerQueueName).toBe('wager-transactions.fifo');
    expect(config.sqs.wagerDlqName).toBe('wager-transactions-dlq.fifo');
    expect(config.sqs.maxReceiveCount).toBe(3);
  });

  it('rejects invalid numeric port, pool, and lock timeout configurations', () => {
    expect(() => loadEnvConfig({ PORT: 'invalid' })).toThrow('Invalid PORT environment variable');
    expect(() => loadEnvConfig({ DB_PORT: '-5' })).toThrow('Invalid DB_PORT environment variable');
    expect(() => loadEnvConfig({ DB_LOCK_TIMEOUT_MS: '0' })).toThrow(
      'Invalid DB_LOCK_TIMEOUT_MS environment variable',
    );
    expect(() => loadEnvConfig({ DB_POOL_MIN: '25', DB_POOL_MAX: '10' })).toThrow(
      'DB_POOL_MIN (25) must not exceed DB_POOL_MAX (10)',
    );
  });
});
