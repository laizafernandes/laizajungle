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
  sqs: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    wagerQueueName: string;
    wagerDlqName: string;
    maxReceiveCount: number;
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  const value = Number.parseInt(raw ?? String(fallback), 10);
  if (Number.isNaN(value) || value <= 0) {
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
    sqs: {
      region: env.AWS_REGION ?? 'us-east-1',
      accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
      endpoint: env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566',
      wagerQueueName: env.SQS_WAGER_QUEUE_NAME ?? 'wager-transactions.fifo',
      wagerDlqName: env.SQS_WAGER_DLQ_NAME ?? 'wager-transactions-dlq.fifo',
      maxReceiveCount,
    },
  };
}
