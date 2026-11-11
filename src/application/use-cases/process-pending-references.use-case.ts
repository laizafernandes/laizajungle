import { WagerTransactionStatus } from '../../domain/index';
import type { MetricsPort, StructuredLoggerPort } from '../ports/observability.ports';
import type {
  ClockPort,
  UnitOfWorkPort,
  WagerTransactionRepositoryPort,
  WalletRepositoryPort,
} from '../ports/wagering.ports';
import type { WagerTransactionResolutionService } from '../services/wager-transaction-resolution.service';

export interface ProcessPendingBatchOptions {
  now?: Date;
  batchSize?: number;
}

export interface ProcessPendingBatchSummary {
  scanned: number;
  resolved: number;
  rejected: number;
  rescheduled: number;
  skipped: number;
}

/**
 * Reprocesses due PENDING_REFERENCE transactions using the global lock order
 * (1. Wallet FOR UPDATE -> 2. WagerTransaction FOR UPDATE SKIP LOCKED)
 * to eliminate AB-BA deadlocks with concurrent HTTP/SQS transactions.
 */
export class ProcessPendingReferencesUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly walletRepository: WalletRepositoryPort,
    private readonly wagerTransactionRepository: WagerTransactionRepositoryPort,
    private readonly resolutionService: WagerTransactionResolutionService,
    private readonly clock: ClockPort,
    private readonly defaultBatchSize = 50,
    private readonly logger?: StructuredLoggerPort,
    private readonly metrics?: MetricsPort,
  ) {}

  async processDueBatch(
    options: ProcessPendingBatchOptions = {},
  ): Promise<ProcessPendingBatchSummary> {
    const now = options.now ?? this.clock.now();
    const batchSize = options.batchSize ?? this.defaultBatchSize;

    const candidates = await this.wagerTransactionRepository.findDuePendingCandidates(
      now,
      batchSize,
    );

    const summary: ProcessPendingBatchSummary = {
      scanned: candidates.length,
      resolved: 0,
      rejected: 0,
      rescheduled: 0,
      skipped: 0,
    };

    for (const candidate of candidates) {
      const outcome = await this.processSingleCandidate(candidate.id, candidate.walletId, now);
      summary[outcome] += 1;
    }

    return summary;
  }

  private async processSingleCandidate(
    transactionId: string,
    walletId: string,
    now: Date,
  ): Promise<'resolved' | 'rejected' | 'rescheduled' | 'skipped'> {
    const startedAt = performance.now();

    return this.unitOfWork.runInTransaction(async (tx) => {
      // Global Lock Order Step 1: Lock Wallet FIRST (same root order as ProcessWagerTransactionUseCase).
      const wallet = await this.walletRepository.findByIdForUpdate(tx, walletId);
      if (!wallet) {
        return 'skipped';
      }

      // Global Lock Order Step 2: Lock specific PENDING_REFERENCE row (SKIP LOCKED if another worker holds it).
      const pendingTx = await this.wagerTransactionRepository.findPendingByIdForUpdate(
        tx,
        transactionId,
      );
      if (!pendingTx) {
        return 'skipped';
      }

      // Re-check due timestamp in case another worker just rescheduled this item.
      if (
        pendingTx.nextReferenceRetryAt &&
        pendingTx.nextReferenceRetryAt.getTime() > now.getTime()
      ) {
        return 'skipped';
      }

      const result = await this.resolutionService.resolveAndApply(
        tx,
        wallet,
        pendingTx,
        now,
        'update',
        { correlationId: pendingTx.id, causationId: pendingTx.id },
      );

      const durationMs = Math.round((performance.now() - startedAt) * 1000) / 1000;

      if (result.status === WagerTransactionStatus.Processed) {
        this.metrics?.recordTransactionOutcome({
          status: result.status,
          kind: pendingTx.kind,
          durationMs,
        });
        this.logger?.info('pending_reference_resolved', {
          correlationId: pendingTx.id,
          transactionId: pendingTx.id,
          walletId: pendingTx.walletId,
          providerId: pendingTx.providerId,
          idempotencyKey: pendingTx.idempotencyKey,
          kind: pendingTx.kind,
          status: result.status,
          durationMs,
        });
        return 'resolved';
      }
      if (result.status === WagerTransactionStatus.Rejected) {
        this.metrics?.recordTransactionOutcome({
          status: result.status,
          kind: pendingTx.kind,
          durationMs,
        });
        this.logger?.warn('pending_reference_rejected', {
          correlationId: pendingTx.id,
          transactionId: pendingTx.id,
          walletId: pendingTx.walletId,
          providerId: pendingTx.providerId,
          idempotencyKey: pendingTx.idempotencyKey,
          kind: pendingTx.kind,
          status: result.status,
          failureCode: result.failureCode,
          durationMs,
        });
        return 'rejected';
      }
      this.metrics?.recordRetry({ component: 'pending_reference' });
      return 'rescheduled';
    });
  }
}
