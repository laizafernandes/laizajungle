import { describe, expect, it } from 'bun:test';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/index';
import {
  JsonStructuredLogger,
  PrometheusMetricsRegistry,
} from '../../src/infrastructure/observability/index';

describe('Sprint 6 — Observability: Structured Logger & Metrics Registry (Unit)', () => {
  it('emits structured JSON with required correlation fields and never leaks monetary amounts or secrets', () => {
    const captured: string[] = [];
    const logger = new JsonStructuredLogger({
      sink: (_level, line) => {
        captured.push(line);
      },
    });

    logger.info('wager_transaction_processed', {
      correlationId: 'corr-123',
      messageId: 'msg-456',
      transactionId: 'tx-789',
      walletId: 'wallet-001',
      providerId: 'provider-a',
      idempotencyKey: 'provider-a:ext-1',
      status: WagerTransactionStatus.Processed,
      kind: WagerTransactionKind.Bet,
      // Intentionally pass sensitive / financial fields to prove logger redaction
      amount: '987.65',
      money: { amount: '987.65', currency: 'BRL' },
      storedBalance: { amount: '500.00', currency: 'BRL' },
      authorization: 'Bearer super-secret-jwt',
      rawBody: '{"money":{"amount":"987.65","currency":"BRL"}}',
    });

    expect(captured).toHaveLength(1);
    const serialized = captured[0] ?? '';
    const parsed = JSON.parse(serialized) as Record<string, unknown>;

    expect(parsed.level).toBe('info');
    expect(parsed.event).toBe('wager_transaction_processed');
    expect(parsed.correlationId).toBe('corr-123');
    expect(parsed.messageId).toBe('msg-456');
    expect(parsed.transactionId).toBe('tx-789');
    expect(parsed.walletId).toBe('wallet-001');
    expect(parsed.providerId).toBe('provider-a');
    expect(parsed.idempotencyKey).toBe('provider-a:ext-1');

    expect(serialized).not.toContain('987.65');
    expect(serialized).not.toContain('500.00');
    expect(serialized).not.toContain('super-secret-jwt');
    expect(parsed.amount).toBeUndefined();
    expect(parsed.money).toBeUndefined();
    expect(parsed.storedBalance).toBeUndefined();
    expect(parsed.authorization).toBeUndefined();
    expect(parsed.rawBody).toBeUndefined();
  });

  it('tracks counters, histogram latency, enforces low-cardinality labels without IDs, and caches/degrades external probes safely', async () => {
    let outboxCalls = 0;
    let dlqCalls = 0;
    let failDlq = false;

    const registry = new PrometheusMetricsRegistry({
      cacheTtlMs: 2000,
      readOutboxLag: async () => {
        outboxCalls += 1;
        return { pendingCount: 3, oldestLagMs: 145 };
      },
      readDlqDepth: async () => {
        dlqCalls += 1;
        if (failDlq) {
          throw new Error('SQS_UNREACHABLE');
        }
        return { approximateVisible: 2, approximateNotVisible: 1 };
      },
    });

    registry.recordTransactionOutcome({
      status: WagerTransactionStatus.Processed,
      kind: WagerTransactionKind.Bet,
      durationMs: 18,
    });
    registry.recordTransactionOutcome({
      status: WagerTransactionStatus.Rejected,
      kind: WagerTransactionKind.Bet,
      durationMs: 7,
    });
    registry.recordDuplicate({ channel: 'http', mechanism: 'idempotency_key' });
    registry.recordDuplicate({ channel: 'sqs', mechanism: 'inbox' });
    registry.recordRetry({ component: 'outbox_publisher' });
    registry.recordDlqRouted({ reason: 'INBOX_PAYLOAD_MISMATCH' });
    registry.recordLockConflict({ source: 'http' });
    registry.recordReconciliationResult({ consistent: false });

    // First scrape populates cache; second immediate scrape reuses cache without hitting dependencies again
    const snap1 = await registry.collectSnapshot();
    const snap2 = await registry.collectSnapshot();
    expect(outboxCalls).toBe(1);
    expect(dlqCalls).toBe(1);
    expect(snap1.outbox.pendingCount).toBe(3);
    expect(snap2.dlq.approximateVisible).toBe(2);

    const text = await registry.renderPrometheus();
    expect(text).toContain('wager_transactions_total{kind="BET",status="PROCESSED"} 1');
    expect(text).toContain('wager_transactions_total{kind="BET",status="REJECTED"} 1');
    expect(text).toContain('wager_duplicates_total{channel="http",mechanism="idempotency_key"} 1');
    expect(text).toContain('wager_duplicates_total{channel="sqs",mechanism="inbox"} 1');
    expect(text).toContain('wager_retries_total{component="outbox_publisher"} 1');
    expect(text).toContain('wager_dlq_routed_total{reason="INBOX_PAYLOAD_MISMATCH"} 1');
    expect(text).toContain('wager_lock_conflicts_total{source="http"} 1');
    expect(text).toContain('wager_reconciliation_mismatches_total 1');
    expect(text).toContain('wager_outbox_pending_count 3');
    expect(text).toContain('wager_outbox_oldest_pending_lag_ms 145');
    expect(text).toContain('wager_sqs_dlq_messages_approximate{state="visible"} 2');
    expect(text).toContain('wager_processing_duration_ms_count 2');

    // Low-cardinality safeguard: forbid entity IDs inside metric label names
    expect(text).not.toMatch(
      /\b(walletId|playerId|transactionId|providerId|idempotencyKey|messageId)=/,
    );
    expect(() => registry.assertAllowedLabels({ walletId: 'abc', status: 'PROCESSED' })).toThrow();

    // Fault tolerance: expire cache by forcing fresh scrape with failing DLQ probe
    failDlq = true;
    const snapDegraded = await registry.collectSnapshot({ forceRefresh: true });
    expect(snapDegraded.scrapeErrors.dlq).toContain('SQS_UNREACHABLE');
    const degradedProm = await registry.renderPrometheus({ forceRefresh: true });
    expect(degradedProm).toContain('wager_metrics_scrape_errors_total{dependency="sqs_dlq"}');
  });
});
