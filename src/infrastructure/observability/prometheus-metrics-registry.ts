import type {
  DuplicateChannel,
  DuplicateMechanism,
  MetricsPort,
  RetryComponent,
} from '../../application/index';
import type { WagerTransactionKind, WagerTransactionStatus } from '../../domain/index';

export interface OutboxLagMetrics {
  pendingCount: number;
  oldestLagMs: number;
}

export interface DlqDepthMetrics {
  approximateVisible: number;
  approximateNotVisible: number;
}

export interface MetricsSnapshot {
  transactions: Record<string, number>;
  duplicates: Record<string, number>;
  retries: Record<string, number>;
  dlqRouted: Record<string, number>;
  lockConflicts: Record<string, number>;
  reconciliations: { consistent: number; inconsistent: number };
  reconciliationMismatches: number;
  durationMs: {
    buckets: Record<string, number>;
    sum: number;
    count: number;
    max: number;
  };
  outbox: OutboxLagMetrics;
  dlq: DlqDepthMetrics;
  scrapeErrors: {
    counters: { outbox: number; sqs_dlq: number };
    outbox?: string;
    dlq?: string;
  };
}

export interface PrometheusMetricsRegistryOptions {
  cacheTtlMs?: number;
  readOutboxLag?: () => Promise<OutboxLagMetrics>;
  readDlqDepth?: () => Promise<DlqDepthMetrics>;
}

const DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 3000];

const FORBIDDEN_HIGH_CARDINALITY_LABELS = new Set([
  'walletid',
  'playerid',
  'transactionid',
  'providerid',
  'idempotencykey',
  'messageid',
  'roundid',
  'externaltransactionid',
  'correlationid',
  'causationid',
  'externalid',
]);

function normalizeLabelName(name: string): string {
  return name.replace(/[_-]/g, '').toLowerCase();
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return '';
  }
  const inner = entries.map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`).join(',');
  return `{${inner}}`;
}

export class PrometheusMetricsRegistry implements MetricsPort {
  private readonly cacheTtlMs: number;
  private readOutboxLag?: () => Promise<OutboxLagMetrics>;
  private readDlqDepth?: () => Promise<DlqDepthMetrics>;

  private readonly txCounters = new Map<string, number>();
  private readonly duplicateCounters = new Map<string, number>();
  private readonly retryCounters = new Map<string, number>();
  private readonly dlqCounters = new Map<string, number>();
  private readonly lockConflictCounters = new Map<string, number>();
  private reconciliationConsistent = 0;
  private reconciliationInconsistent = 0;

  private readonly durationBuckets = new Map<number, number>(
    DURATION_BUCKETS_MS.map((b) => [b, 0]),
  );
  private durationInfCount = 0;
  private durationSum = 0;
  private durationCount = 0;
  private durationMax = 0;

  private cachedOutbox: { at: number; value: OutboxLagMetrics; error?: string } | undefined;
  private cachedDlq: { at: number; value: DlqDepthMetrics; error?: string } | undefined;
  private outboxScrapeErrors = 0;
  private dlqScrapeErrors = 0;

  constructor(options: PrometheusMetricsRegistryOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? 3000;
    this.readOutboxLag = options.readOutboxLag;
    this.readDlqDepth = options.readDlqDepth;
  }

  setExternalReaders(readers: {
    readOutboxLag?: () => Promise<OutboxLagMetrics>;
    readDlqDepth?: () => Promise<DlqDepthMetrics>;
  }): void {
    this.readOutboxLag = readers.readOutboxLag ?? this.readOutboxLag;
    this.readDlqDepth = readers.readDlqDepth ?? this.readDlqDepth;
    this.cachedOutbox = undefined;
    this.cachedDlq = undefined;
  }

  assertAllowedLabels(labels: Record<string, string>): void {
    for (const key of Object.keys(labels)) {
      if (FORBIDDEN_HIGH_CARDINALITY_LABELS.has(normalizeLabelName(key))) {
        throw new Error(`High-cardinality ID label "${key}" is forbidden on metrics`);
      }
    }
  }

  recordTransactionOutcome(params: {
    status: WagerTransactionStatus;
    kind: WagerTransactionKind;
    durationMs: number;
  }): void {
    this.incrementCounter(this.txCounters, {
      kind: params.kind,
      status: params.status,
    });
    this.observeDuration(params.durationMs);
  }

  recordDuplicate(params: { channel: DuplicateChannel; mechanism: DuplicateMechanism }): void {
    this.incrementCounter(this.duplicateCounters, {
      channel: params.channel,
      mechanism: params.mechanism,
    });
  }

  recordRetry(params: { component: RetryComponent }): void {
    this.incrementCounter(this.retryCounters, { component: params.component });
  }

  recordDlqRouted(params: { reason: string }): void {
    this.incrementCounter(this.dlqCounters, { reason: params.reason });
  }

  recordLockConflict(params: { source: DuplicateChannel }): void {
    this.incrementCounter(this.lockConflictCounters, { source: params.source });
  }

  recordReconciliationResult(params: { consistent: boolean }): void {
    if (params.consistent) {
      this.reconciliationConsistent += 1;
    } else {
      this.reconciliationInconsistent += 1;
    }
  }

  async collectSnapshot(options: { forceRefresh?: boolean } = {}): Promise<MetricsSnapshot> {
    const now = Date.now();
    const [outboxRes, dlqRes] = await Promise.all([
      this.readOutboxWithCache(now, options.forceRefresh ?? false),
      this.readDlqWithCache(now, options.forceRefresh ?? false),
    ]);

    const bucketsObj: Record<string, number> = {};
    for (const b of DURATION_BUCKETS_MS) {
      bucketsObj[String(b)] = this.durationBuckets.get(b) ?? 0;
    }
    bucketsObj['+Inf'] = this.durationInfCount;

    return {
      transactions: Object.fromEntries(this.txCounters),
      duplicates: Object.fromEntries(this.duplicateCounters),
      retries: Object.fromEntries(this.retryCounters),
      dlqRouted: Object.fromEntries(this.dlqCounters),
      lockConflicts: Object.fromEntries(this.lockConflictCounters),
      reconciliations: {
        consistent: this.reconciliationConsistent,
        inconsistent: this.reconciliationInconsistent,
      },
      reconciliationMismatches: this.reconciliationInconsistent,
      durationMs: {
        buckets: bucketsObj,
        sum: Number(this.durationSum.toFixed(3)),
        count: this.durationCount,
        max: Number(this.durationMax.toFixed(3)),
      },
      outbox: outboxRes.value,
      dlq: dlqRes.value,
      scrapeErrors: {
        counters: {
          outbox: this.outboxScrapeErrors,
          sqs_dlq: this.dlqScrapeErrors,
        },
        ...(outboxRes.error ? { outbox: outboxRes.error } : {}),
        ...(dlqRes.error ? { dlq: dlqRes.error } : {}),
      },
    };
  }

  async renderPrometheus(options: { forceRefresh?: boolean } = {}): Promise<string> {
    const snapshot = await this.collectSnapshot(options);
    const lines: string[] = [];

    this.pushCounterSeries(
      lines,
      'wager_transactions_total',
      'Total wagering transactions processed by kind and terminal/pending status.',
      this.txCounters,
    );
    this.pushCounterSeries(
      lines,
      'wager_duplicates_total',
      'Total deduplicated requests detected by channel and persistence mechanism.',
      this.duplicateCounters,
    );
    this.pushCounterSeries(
      lines,
      'wager_retries_total',
      'Total retry attempts triggered by async workers and SQS consumer.',
      this.retryCounters,
    );
    this.pushCounterSeries(
      lines,
      'wager_dlq_routed_total',
      'Total messages classified as permanent failure for DLQ routing.',
      this.dlqCounters,
    );
    this.pushCounterSeries(
      lines,
      'wager_lock_conflicts_total',
      'Total wallet pessimistic lock timeouts (WALLET_LOCK_TIMEOUT / 503).',
      this.lockConflictCounters,
    );

    lines.push(
      '# HELP wager_reconciliations_total Wallet reconciliation checks partitioned by consistency.',
      '# TYPE wager_reconciliations_total counter',
      `wager_reconciliations_total{consistent="true"} ${snapshot.reconciliations.consistent}`,
      `wager_reconciliations_total{consistent="false"} ${snapshot.reconciliations.inconsistent}`,
      '# HELP wager_reconciliation_mismatches_total Total wallet vs ledger mismatches detected.',
      '# TYPE wager_reconciliation_mismatches_total counter',
      `wager_reconciliation_mismatches_total ${snapshot.reconciliationMismatches}`,
      '# HELP wager_outbox_pending_count Current unpublished outbox events in PostgreSQL.',
      '# TYPE wager_outbox_pending_count gauge',
      `wager_outbox_pending_count ${snapshot.outbox.pendingCount}`,
      '# HELP wager_outbox_oldest_pending_lag_ms Age in milliseconds of the oldest unpublished outbox event.',
      '# TYPE wager_outbox_oldest_pending_lag_ms gauge',
      `wager_outbox_oldest_pending_lag_ms ${snapshot.outbox.oldestLagMs}`,
      '# HELP wager_sqs_dlq_messages_approximate Approximate messages present in wager-transactions-dlq.fifo.',
      '# TYPE wager_sqs_dlq_messages_approximate gauge',
      `wager_sqs_dlq_messages_approximate{state="visible"} ${snapshot.dlq.approximateVisible}`,
      `wager_sqs_dlq_messages_approximate{state="not_visible"} ${snapshot.dlq.approximateNotVisible}`,
      '# HELP wager_metrics_scrape_errors_total Dependency probe failures tolerated during /metrics scrape.',
      '# TYPE wager_metrics_scrape_errors_total counter',
      `wager_metrics_scrape_errors_total{dependency="outbox"} ${snapshot.scrapeErrors.counters.outbox}`,
      `wager_metrics_scrape_errors_total{dependency="sqs_dlq"} ${snapshot.scrapeErrors.counters.sqs_dlq}`,
      '# HELP wager_processing_duration_ms Processing latency histogram in milliseconds.',
      '# TYPE wager_processing_duration_ms histogram',
    );

    for (const bound of DURATION_BUCKETS_MS) {
      lines.push(
        `wager_processing_duration_ms_bucket{le="${bound}"} ${this.durationBuckets.get(bound) ?? 0}`,
      );
    }
    lines.push(
      `wager_processing_duration_ms_bucket{le="+Inf"} ${this.durationInfCount}`,
      `wager_processing_duration_ms_sum ${snapshot.durationMs.sum}`,
      `wager_processing_duration_ms_count ${snapshot.durationMs.count}`,
    );

    return `${lines.join('\n')}\n`;
  }

  private pushCounterSeries(
    lines: string[],
    metricName: string,
    help: string,
    store: Map<string, number>,
  ): void {
    lines.push(`# HELP ${metricName} ${help}`, `# TYPE ${metricName} counter`);
    const entries = Array.from(store.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [labelKey, count] of entries) {
      lines.push(`${metricName}${labelKey} ${count}`);
    }
  }

  private incrementCounter(store: Map<string, number>, labels: Record<string, string>): void {
    this.assertAllowedLabels(labels);
    const key = formatLabels(labels);
    store.set(key, (store.get(key) ?? 0) + 1);
  }

  private observeDuration(durationMs: number): void {
    const safeDuration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
    this.durationSum += safeDuration;
    this.durationCount += 1;
    if (safeDuration > this.durationMax) {
      this.durationMax = safeDuration;
    }
    this.durationInfCount += 1;
    for (const bound of DURATION_BUCKETS_MS) {
      if (safeDuration <= bound) {
        this.durationBuckets.set(bound, (this.durationBuckets.get(bound) ?? 0) + 1);
      }
    }
  }

  private async readOutboxWithCache(
    now: number,
    forceRefresh: boolean,
  ): Promise<{ value: OutboxLagMetrics; error?: string }> {
    if (!forceRefresh && this.cachedOutbox && now - this.cachedOutbox.at < this.cacheTtlMs) {
      return { value: this.cachedOutbox.value, error: this.cachedOutbox.error };
    }

    if (!this.readOutboxLag) {
      return { value: { pendingCount: 0, oldestLagMs: 0 } };
    }

    try {
      const value = await this.readOutboxLag();
      this.cachedOutbox = { at: now, value };
      return { value };
    } catch (error) {
      this.outboxScrapeErrors += 1;
      const errMsg = error instanceof Error ? error.message : String(error);
      const fallback = this.cachedOutbox?.value ?? { pendingCount: 0, oldestLagMs: 0 };
      this.cachedOutbox = { at: now, value: fallback, error: errMsg };
      return { value: fallback, error: errMsg };
    }
  }

  private async readDlqWithCache(
    now: number,
    forceRefresh: boolean,
  ): Promise<{ value: DlqDepthMetrics; error?: string }> {
    if (!forceRefresh && this.cachedDlq && now - this.cachedDlq.at < this.cacheTtlMs) {
      return { value: this.cachedDlq.value, error: this.cachedDlq.error };
    }

    if (!this.readDlqDepth) {
      return { value: { approximateVisible: 0, approximateNotVisible: 0 } };
    }

    try {
      const value = await this.readDlqDepth();
      this.cachedDlq = { at: now, value };
      return { value };
    } catch (error) {
      this.dlqScrapeErrors += 1;
      const errMsg = error instanceof Error ? error.message : String(error);
      const fallback = this.cachedDlq?.value ?? {
        approximateVisible: 0,
        approximateNotVisible: 0,
      };
      this.cachedDlq = { at: now, value: fallback, error: errMsg };
      return { value: fallback, error: errMsg };
    }
  }
}
