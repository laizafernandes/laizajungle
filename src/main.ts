import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnvConfig } from './infrastructure/config/env.config';

async function bootstrap(): Promise<void> {
  const config = loadEnvConfig();
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  app.enableShutdownHooks();

  await app.listen(config.port, '0.0.0.0');
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'application_started',
      port: config.port,
      nodeEnv: config.nodeEnv,
      timestamp: new Date().toISOString(),
    }),
  );
}

if (import.meta.main) {
  bootstrap().catch((err) => {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'application_bootstrap_failed',
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
    process.exit(1);
  });
}
