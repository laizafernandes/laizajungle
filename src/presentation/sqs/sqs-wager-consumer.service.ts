import { createHash } from 'node:crypto';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  CanonicalPayloadHasher,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InboxPayloadMismatchError,
  LOGGER_PORT,
  METRICS_PORT,
  type MetricsPort,
  ProcessWagerTransactionUseCase,
  type StructuredLoggerPort,
  TransientInfrastructureError,
  ValidationApplicationError,
  WalletNotFoundError,
} from '../../application/index';
import { isPermanentPgError } from '../../application/services/validation.helpers';
import { DomainError, Money, type MoneyProps, WagerTransactionKind } from '../../domain/index';
import { type AppEnvConfig, loadEnvConfig } from '../../infrastructure/config/env.config';
import { SQS_CLIENT_TOKEN } from '../../infrastructure/messaging/sqs.client';

export interface SqsWagerConsumerFaultHooks {
  beforeProcessMessage?: (context: { messageId: string; walletId: string }) => void | Promise<void>;
  afterCommitBeforeAck?: (context: { messageId: string; walletId: string }) => void | Promise<void>;
}

export interface ConsumerBatchSummary {
  acked: number;
  retried: number;
  visibilityReturned: number;
}

interface ParsedEnvelope {
  messageId: string;
  walletId: string;
  payloadHash: string;
  occurredAt: Date;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: MoneyProps;
    referenceExternalTransactionId?: string;
  };
}

class MalformedSqsEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedSqsEnvelopeError';
  }
}

const VALID_KINDS = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

@Injectable()
export class SqsWagerConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly config: AppEnvConfig;
  private cachedQueueUrl?: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private inFlight: Promise<void> | null = null;
  private faultHooks: SqsWagerConsumerFaultHooks = {};

  constructor(
    @Inject(SQS_CLIENT_TOKEN) private readonly sqsClient: SQSClient,
    @Inject(ProcessWagerTransactionUseCase)
    private readonly processWagerTransactionUseCase: ProcessWagerTransactionUseCase,
    @Optional() config?: AppEnvConfig,
    @Optional() @Inject(LOGGER_PORT) private readonly logger?: StructuredLoggerPort,
    @Optional() @Inject(METRICS_PORT) private readonly metrics?: MetricsPort,
  ) {
    this.config = config ?? loadEnvConfig();
  }

  onModuleInit(): void {
    if (!this.config.sqs.consumerEnabled) {
      return;
    }
    this.scheduleNextTick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.inFlight) {
      await this.inFlight;
    }
  }

  setFaultHooks(hooks: SqsWagerConsumerFaultHooks): void {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Fault hooks cannot be configured in production');
    }
    this.faultHooks = hooks;
  }

  clearFaultHooks(): void {
    this.faultHooks = {};
  }

  async pollAndProcessOnce(): Promise<number> {
    const queueUrl = await this.getQueueUrl();
    const res = await this.sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: this.config.sqs.consumerBatchSize,
        WaitTimeSeconds: this.stopped ? 0 : this.config.sqs.consumerWaitTimeSeconds,
        VisibilityTimeout: this.config.sqs.consumerVisibilityTimeoutSec,
        AttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );

    const messages = res.Messages ?? [];
    if (messages.length === 0) {
      return 0;
    }

    const summary = await this.processReceivedBatch(messages);
    return summary.acked;
  }

  async processReceivedBatch(messages: Message[]): Promise<ConsumerBatchSummary> {
    const summary: ConsumerBatchSummary = {
      acked: 0,
      retried: 0,
      visibilityReturned: 0,
    };

    if (messages.length === 0) {
      return summary;
    }

    const queueUrl = await this.getQueueUrl();
    const groups = this.groupMessagesByGroupKey(messages);
    const groupQueue = Array.from(groups.values());

    const workerCount = Math.min(this.config.sqs.consumerConcurrency, groupQueue.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const group = groupQueue.shift();
        if (!group) {
          return;
        }
        await this.processWalletGroup(queueUrl, group, summary);
      }
    });

    await Promise.all(workers);
    return summary;
  }

  private async processWalletGroup(
    queueUrl: string,
    groupMessages: Array<{ raw: Message; parsed?: ParsedEnvelope; parseError?: Error }>,
    summary: ConsumerBatchSummary,
  ): Promise<void> {
    for (let i = 0; i < groupMessages.length; i++) {
      const item = groupMessages[i];
      if (!item) {
        continue;
      }

      try {
        if (item.parseError || !item.parsed) {
          throw item.parseError ?? new MalformedSqsEnvelopeError('Empty or invalid SQS envelope');
        }

        const parsed = item.parsed;
        await this.faultHooks.beforeProcessMessage?.({
          messageId: parsed.messageId,
          walletId: parsed.walletId,
        });

        await this.processWagerTransactionUseCase.execute({
          ...parsed.data,
          correlationId: parsed.messageId,
          causationId: parsed.messageId,
          inboxContext: {
            consumerName: this.config.sqs.consumerName,
            messageId: parsed.messageId,
            payloadHash: parsed.payloadHash,
            receivedAt: parsed.occurredAt,
          },
        });

        await this.faultHooks.afterCommitBeforeAck?.({
          messageId: parsed.messageId,
          walletId: parsed.walletId,
        });

        if (item.raw.ReceiptHandle) {
          await this.sqsClient.send(
            new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: item.raw.ReceiptHandle,
            }),
          );
        }

        this.logger?.info('sqs_message_acked', {
          correlationId: parsed.messageId,
          messageId: parsed.messageId,
          walletId: parsed.walletId,
          providerId: parsed.data.providerId,
          idempotencyKey: parsed.data.idempotencyKey,
        });

        summary.acked += 1;
      } catch (error) {
        summary.retried += 1;

        const messageId = item.parsed?.messageId ?? item.raw.MessageId ?? 'unknown';
        const walletId = item.parsed?.walletId;
        const providerId = item.parsed?.data.providerId;
        const reason = error instanceof Error ? error.name : 'UNKNOWN_ERROR';

        const visibilityTimeoutSec = item.raw.ReceiptHandle
          ? this.computeRetryVisibilityTimeoutSec(item.raw, error)
          : 0;

        if (this.isNonTransientDlqError(error)) {
          this.metrics?.recordDlqRouted({ reason });
          this.logger?.warn('sqs_message_dlq_routed', {
            correlationId: messageId,
            messageId,
            ...(walletId ? { walletId } : {}),
            ...(providerId ? { providerId } : {}),
            reason,
          });
        } else {
          this.metrics?.recordRetry({ component: 'sqs_consumer' });
          this.logger?.warn('sqs_message_retry', {
            correlationId: messageId,
            messageId,
            ...(walletId ? { walletId } : {}),
            ...(providerId ? { providerId } : {}),
            reason,
            visibilityTimeoutSec,
          });
        }

        if (item.raw.ReceiptHandle) {
          await this.safeChangeVisibility(queueUrl, item.raw.ReceiptHandle, visibilityTimeoutSec);
        }

        // Preserve strict per-wallet ordering: do not process subsequent messages for the same
        // walletId in this batch, and immediately return their visibility to 0s.
        for (let j = i + 1; j < groupMessages.length; j++) {
          const remaining = groupMessages[j];
          if (remaining?.raw.ReceiptHandle) {
            await this.safeChangeVisibility(queueUrl, remaining.raw.ReceiptHandle, 0);
            summary.visibilityReturned += 1;
          }
        }
        break;
      }
    }
  }

  private groupMessagesByGroupKey(
    messages: Message[],
  ): Map<string, Array<{ raw: Message; parsed?: ParsedEnvelope; parseError?: Error }>> {
    const groups = new Map<
      string,
      Array<{ raw: Message; parsed?: ParsedEnvelope; parseError?: Error }>
    >();

    messages.forEach((raw, index) => {
      let parsed: ParsedEnvelope | undefined;
      let parseError: Error | undefined;

      try {
        parsed = this.parseEnvelope(raw);
      } catch (error) {
        parseError = error instanceof Error ? error : new MalformedSqsEnvelopeError(String(error));
      }

      const groupKey =
        raw.Attributes?.MessageGroupId ??
        parsed?.walletId ??
        `__malformed__:${raw.MessageId ?? index}`;

      const list = groups.get(groupKey);
      if (list) {
        list.push({ raw, parsed, parseError });
      } else {
        groups.set(groupKey, [{ raw, parsed, parseError }]);
      }
    });

    return groups;
  }

  private parseEnvelope(message: Message): ParsedEnvelope {
    if (!message.Body) {
      throw new MalformedSqsEnvelopeError('SQS message body is empty');
    }

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(message.Body);
    } catch {
      throw new MalformedSqsEnvelopeError('SQS message body is not valid JSON');
    }

    if (!rawJson || typeof rawJson !== 'object' || Array.isArray(rawJson)) {
      throw new MalformedSqsEnvelopeError('SQS envelope must be a JSON object');
    }

    const env = rawJson as Record<string, unknown>;
    if (typeof env.messageId !== 'string' || !env.messageId.trim()) {
      throw new MalformedSqsEnvelopeError('Envelope messageId must be a non-empty string');
    }
    if (env.type !== 'WagerTransactionRequested') {
      throw new MalformedSqsEnvelopeError(`Unsupported SQS message type: ${String(env.type)}`);
    }
    if (typeof env.occurredAt !== 'string' || Number.isNaN(Date.parse(env.occurredAt))) {
      throw new MalformedSqsEnvelopeError('Envelope occurredAt must be a valid ISO timestamp');
    }
    if (!env.data || typeof env.data !== 'object' || Array.isArray(env.data)) {
      throw new MalformedSqsEnvelopeError('Envelope data must be a JSON object');
    }

    const data = env.data as Record<string, unknown>;
    const requiredStrings = [
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'playerId',
      'walletId',
      'roundId',
      'gameId',
      'kind',
    ] as const;

    for (const field of requiredStrings) {
      const value = data[field];
      if (typeof value !== 'string' || !value.trim()) {
        throw new MalformedSqsEnvelopeError(`Envelope data.${field} must be a non-empty string`);
      }
    }

    const kind = data.kind as string;
    if (!VALID_KINDS.has(kind)) {
      throw new MalformedSqsEnvelopeError(`Invalid transaction kind: ${kind}`);
    }

    if (!data.money || typeof data.money !== 'object' || Array.isArray(data.money)) {
      throw new MalformedSqsEnvelopeError('Envelope data.money must be an object');
    }
    const rawMoney = data.money as Record<string, unknown>;
    if (typeof rawMoney.amount !== 'string' || typeof rawMoney.currency !== 'string') {
      throw new MalformedSqsEnvelopeError(
        'Envelope data.money requires string amount and currency',
      );
    }

    const normalizedMoney = Money.from({
      amount: rawMoney.amount,
      currency: rawMoney.currency,
    });
    if (!normalizedMoney.isPositive()) {
      throw new MalformedSqsEnvelopeError('Envelope data.money.amount must be > 0.00');
    }

    const referenceExternalTransactionId =
      typeof data.referenceExternalTransactionId === 'string' &&
      data.referenceExternalTransactionId.trim()
        ? data.referenceExternalTransactionId
        : undefined;

    const canonicalPayloadHash = CanonicalPayloadHasher.hash({
      providerId: data.providerId as string,
      externalTransactionId: data.externalTransactionId as string,
      playerId: data.playerId as string,
      walletId: data.walletId as string,
      roundId: data.roundId as string,
      gameId: data.gameId as string,
      kind: kind as WagerTransactionKind,
      money: normalizedMoney.toJSON(),
      referenceExternalTransactionId,
    });

    const inboxPayloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          type: env.type,
          idempotencyKey: data.idempotencyKey,
          canonicalPayloadHash,
        }),
      )
      .digest('hex');

    return {
      messageId: env.messageId,
      walletId: data.walletId as string,
      payloadHash: inboxPayloadHash,
      occurredAt: new Date(env.occurredAt),
      data: {
        providerId: data.providerId as string,
        externalTransactionId: data.externalTransactionId as string,
        idempotencyKey: data.idempotencyKey as string,
        playerId: data.playerId as string,
        walletId: data.walletId as string,
        roundId: data.roundId as string,
        gameId: data.gameId as string,
        kind: kind as WagerTransactionKind,
        money: normalizedMoney.toJSON(),
        ...(referenceExternalTransactionId ? { referenceExternalTransactionId } : {}),
      },
    };
  }

  private computeRetryVisibilityTimeoutSec(message: Message, error: unknown): number {
    if (this.isNonTransientDlqError(error)) {
      return 0;
    }

    if (error instanceof TransientInfrastructureError) {
      return Math.min(this.config.sqs.consumerVisibilityTimeoutSec, error.retryAfterSeconds);
    }

    const receiveCount =
      Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10) || 1;
    const base = this.config.sqs.consumerTransientBackoffBaseSec;
    const delay = base * 2 ** Math.max(0, receiveCount - 1);
    return Math.min(this.config.sqs.consumerVisibilityTimeoutSec, delay);
  }

  private isNonTransientDlqError(error: unknown): boolean {
    return (
      error instanceof MalformedSqsEnvelopeError ||
      error instanceof ValidationApplicationError ||
      error instanceof IdempotencyConflictError ||
      error instanceof ExternalTransactionConflictError ||
      error instanceof InboxPayloadMismatchError ||
      error instanceof WalletNotFoundError ||
      error instanceof DomainError ||
      isPermanentPgError(error)
    );
  }

  private async safeChangeVisibility(
    queueUrl: string,
    receiptHandle: string,
    visibilityTimeout: number,
  ): Promise<void> {
    try {
      await this.sqsClient.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: visibilityTimeout,
        }),
      );
    } catch {
      // ReceiptHandle may already be expired; ignore cleanup failure so batch continues cleanly.
    }
  }

  private async getQueueUrl(): Promise<string> {
    if (this.cachedQueueUrl) {
      return this.cachedQueueUrl;
    }

    const res = await this.sqsClient.send(
      new GetQueueUrlCommand({ QueueName: this.config.sqs.wagerQueueName }),
    );
    if (!res.QueueUrl) {
      throw new Error(`Unable to resolve SQS queue URL: ${this.config.sqs.wagerQueueName}`);
    }
    this.cachedQueueUrl = res.QueueUrl;
    return res.QueueUrl;
  }

  private scheduleNextTick(): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.inFlight = this.runTick().finally(() => {
        this.inFlight = null;
        this.scheduleNextTick();
      });
    }, this.config.sqs.consumerPollIntervalMs);
  }

  private async runTick(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      await this.pollAndProcessOnce();
    } catch (error) {
      if (this.stopped) {
        return;
      }
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'sqs_consumer_tick_failed',
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }
}
