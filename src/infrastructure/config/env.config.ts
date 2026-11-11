export interface AppEnvConfig {
  nodeEnv: string;
  port: number;
  logLevel: string;
  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    name: string;
    poolMin: number;
    poolMax: number;
    lockTimeoutMs: number;
  };
  pendingReference: {
    baseDelayMs: number;
    maxDelayMs: number;
    maxAttempts: number;
    ttlMs: number;
    pollIntervalMs: number;
    batchSize: number;
    workerEnabled: boolean;
  };
  sqs: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    wagerQueueName: string;
    wagerDlqName: string;
    eventsQueueName: string;
    maxReceiveCount: number;
    consumerEnabled: boolean;
    consumerName: string;
    consumerBatchSize: number;
    consumerConcurrency: number;
    consumerWaitTimeSeconds: number;
    consumerPollIntervalMs: number;
    consumerVisibilityTimeoutSec: number;
    consumerTransientBackoffBaseSec: number;
  };
  outbox: {
    publisherEnabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  const value = Number.parseInt(raw ?? String(fallback), 10);
  if (Number.isNaN(value) || value <= 0) {
    throw new Error(`Invalid ${name} environment variable: ${raw}`);
  }
  return value;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number, name: string): number {
  const value = Number.parseInt(raw ?? String(fallback), 10);
  if (Number.isNaN(value) || value < 0) {
    throw new Error(`Invalid ${name} environment variable: ${raw}`);
  }
  return value;
}

export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): AppEnvConfig {
  const port = parsePositiveInt(env.PORT, 3000, 'PORT');
  const dbPort = parsePositiveInt(env.DB_PORT, 5432, 'DB_PORT');
  const poolMin = parsePositiveInt(env.DB_POOL_MIN, 2, 'DB_POOL_MIN');
  const poolMax = parsePositiveInt(env.DB_POOL_MAX, 20, 'DB_POOL_MAX');
  const lockTimeoutMs = parsePositiveInt(env.DB_LOCK_TIMEOUT_MS, 3000, 'DB_LOCK_TIMEOUT_MS');
  const maxReceiveCount = parsePositiveInt(env.SQS_MAX_RECEIVE_COUNT, 3, 'SQS_MAX_RECEIVE_COUNT');

  const pendingBaseDelayMs = parsePositiveInt(
    env.PENDING_REF_BASE_DELAY_MS,
    1000,
    'PENDING_REF_BASE_DELAY_MS',
  );
  const pendingMaxDelayMs = parsePositiveInt(
    env.PENDING_REF_MAX_DELAY_MS,
    30_000,
    'PENDING_REF_MAX_DELAY_MS',
  );
  const pendingMaxAttempts = parsePositiveInt(
    env.PENDING_REF_MAX_ATTEMPTS,
    5,
    'PENDING_REF_MAX_ATTEMPTS',
  );
  const pendingTtlMs = parsePositiveInt(env.PENDING_REF_TTL_MS, 300_000, 'PENDING_REF_TTL_MS');
  const pendingPollIntervalMs = parsePositiveInt(
    env.PENDING_REF_POLL_INTERVAL_MS,
    1000,
    'PENDING_REF_POLL_INTERVAL_MS',
  );
  const pendingBatchSize = parsePositiveInt(
    env.PENDING_REF_BATCH_SIZE,
    50,
    'PENDING_REF_BATCH_SIZE',
  );
  const workerEnabled = (env.PENDING_REF_WORKER_ENABLED ?? 'true').toLowerCase() !== 'false';

  const consumerEnabled = (env.SQS_CONSUMER_ENABLED ?? 'true').toLowerCase() !== 'false';
  const consumerBatchSize = parsePositiveInt(
    env.SQS_CONSUMER_BATCH_SIZE,
    10,
    'SQS_CONSUMER_BATCH_SIZE',
  );
  const consumerConcurrency = parsePositiveInt(
    env.SQS_CONSUMER_CONCURRENCY,
    5,
    'SQS_CONSUMER_CONCURRENCY',
  );
  const consumerWaitTimeSeconds = parseNonNegativeInt(
    env.SQS_CONSUMER_WAIT_TIME_SECONDS,
    1,
    'SQS_CONSUMER_WAIT_TIME_SECONDS',
  );
  const consumerPollIntervalMs = parseNonNegativeInt(
    env.SQS_CONSUMER_POLL_INTERVAL_MS,
    50,
    'SQS_CONSUMER_POLL_INTERVAL_MS',
  );
  const consumerVisibilityTimeoutSec = parsePositiveInt(
    env.SQS_CONSUMER_VISIBILITY_TIMEOUT_SEC,
    30,
    'SQS_CONSUMER_VISIBILITY_TIMEOUT_SEC',
  );
  const consumerTransientBackoffBaseSec = parsePositiveInt(
    env.SQS_CONSUMER_TRANSIENT_BACKOFF_BASE_SEC,
    1,
    'SQS_CONSUMER_TRANSIENT_BACKOFF_BASE_SEC',
  );

  const outboxPublisherEnabled = (env.OUTBOX_PUBLISHER_ENABLED ?? 'true').toLowerCase() !== 'false';
  const outboxPollIntervalMs = parsePositiveInt(
    env.OUTBOX_POLL_INTERVAL_MS,
    200,
    'OUTBOX_POLL_INTERVAL_MS',
  );
  const outboxBatchSize = parsePositiveInt(env.OUTBOX_BATCH_SIZE, 50, 'OUTBOX_BATCH_SIZE');
  const outboxBaseDelayMs = parsePositiveInt(env.OUTBOX_BASE_DELAY_MS, 500, 'OUTBOX_BASE_DELAY_MS');
  const outboxMaxDelayMs = parsePositiveInt(env.OUTBOX_MAX_DELAY_MS, 30_000, 'OUTBOX_MAX_DELAY_MS');

  if (poolMin > poolMax) {
    throw new Error(`DB_POOL_MIN (${poolMin}) must not exceed DB_POOL_MAX (${poolMax})`);
  }

  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    port,
    logLevel: env.LOG_LEVEL ?? 'info',
    db: {
      host: env.DB_HOST ?? '127.0.0.1',
      port: dbPort,
      user: env.DB_USER ?? 'jungle',
      password: env.DB_PASSWORD ?? 'jungle_secret',
      name: env.DB_NAME ?? 'jungle_wagering',
      poolMin,
      poolMax,
      lockTimeoutMs,
    },
    pendingReference: {
      baseDelayMs: pendingBaseDelayMs,
      maxDelayMs: pendingMaxDelayMs,
      maxAttempts: pendingMaxAttempts,
      ttlMs: pendingTtlMs,
      pollIntervalMs: pendingPollIntervalMs,
      batchSize: pendingBatchSize,
      workerEnabled,
    },
    sqs: {
      region: env.AWS_REGION ?? 'us-east-1',
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
      endpoint: env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
      wagerQueueName: env.SQS_WAGER_QUEUE_NAME ?? 'wager-transactions.fifo',
      wagerDlqName: env.SQS_WAGER_DLQ_NAME ?? 'wager-transactions-dlq.fifo',
      eventsQueueName: env.SQS_EVENTS_QUEUE_NAME ?? 'wager-events.fifo',
      maxReceiveCount,
      consumerEnabled,
      consumerName: env.SQS_CONSUMER_NAME ?? 'wager-transactions-consumer',
      consumerBatchSize,
      consumerConcurrency,
      consumerWaitTimeSeconds,
      consumerPollIntervalMs,
      consumerVisibilityTimeoutSec,
      consumerTransientBackoffBaseSec,
    },
    outbox: {
      publisherEnabled: outboxPublisherEnabled,
      pollIntervalMs: outboxPollIntervalMs,
      batchSize: outboxBatchSize,
      baseDelayMs: outboxBaseDelayMs,
      maxDelayMs: outboxMaxDelayMs,
    },
  };
}
