import type { WagerTransactionKind, WagerTransactionStatus } from '../../domain/index';

export const LOGGER_PORT = Symbol('LOGGER_PORT');
export const METRICS_PORT = Symbol('METRICS_PORT');
export const PROVIDER_IDENTITY_PORT = Symbol('PROVIDER_IDENTITY_PORT');

export type LogFields = Record<string, unknown>;

export interface StructuredLoggerPort {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export type DuplicateChannel = 'http' | 'sqs';
export type DuplicateMechanism = 'idempotency_key' | 'inbox';
export type RetryComponent = 'pending_reference' | 'sqs_consumer' | 'outbox_publisher';

export interface MetricsPort {
  recordTransactionOutcome(params: {
    status: WagerTransactionStatus;
    kind: WagerTransactionKind;
    durationMs: number;
  }): void;
  recordDuplicate(params: { channel: DuplicateChannel; mechanism: DuplicateMechanism }): void;
  recordRetry(params: { component: RetryComponent }): void;
  recordDlqRouted(params: { reason: string }): void;
  recordLockConflict(params: { source: DuplicateChannel }): void;
  recordReconciliationResult(params: { consistent: boolean }): void;
}

export interface ProviderAuthContext {
  authenticated: boolean;
  providerId?: string;
  mechanism: 'noop' | 'oidc';
}

export interface ProviderIdentityPort {
  resolveFromHeaders(headers: Record<string, string | string[] | undefined>): ProviderAuthContext;
}
