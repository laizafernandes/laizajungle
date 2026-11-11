import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnvConfig } from '../src/infrastructure/config/env.config';
import { buildMikroOrmOptions } from '../src/infrastructure/database/mikro-orm.config';
import { createSqsClient, verifySqsQueues } from '../src/infrastructure/messaging/sqs.client';

export interface WaitForInfraOptions {
  timeoutMs?: number;
  intervalMs?: number;
  silent?: boolean;
}

export async function waitForInfrastructure(options: WaitForInfraOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const silent = options.silent ?? false;
  const deadline = Date.now() + timeoutMs;

  const config = loadEnvConfig();
  let lastPostgresError = 'not checked yet';
  let lastSqsError = 'not checked yet';

  while (Date.now() < deadline) {
    let pgReady = false;
    let sqsReady = false;

    try {
      const orm = await MikroORM.init(buildMikroOrmOptions());
      try {
        const rows = await orm.em.getConnection().execute<Array<{ ok: number }>>('SELECT 1 AS ok');
        pgReady = rows[0]?.ok === 1;
      } finally {
        await orm.close(true);
      }
    } catch (err) {
      lastPostgresError = err instanceof Error ? err.message : String(err);
    }

    const sqsClient = createSqsClient(config);
    try {
      const verified = await verifySqsQueues(sqsClient, config);
      sqsReady = verified.fifoEnabled && verified.maxReceiveCount > 0;
    } catch (err) {
      lastSqsError = err instanceof Error ? err.message : String(err);
    } finally {
      sqsClient.destroy();
    }

    if (pgReady && sqsReady) {
      if (!silent) {
        console.log(
          '[infra:wait] PostgreSQL and LocalStack SQS FIFO queues are healthy and ready.',
        );
      }
      return;
    }

    if (!silent) {
      console.log(
        `[infra:wait] Waiting for containers... (postgres=${pgReady ? 'ready' : 'waiting'}, sqs=${sqsReady ? 'ready' : 'waiting'})`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for infrastructure. Last Postgres error: ${lastPostgresError} | Last SQS error: ${lastSqsError}`,
  );
}

if (import.meta.main) {
  waitForInfrastructure().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
