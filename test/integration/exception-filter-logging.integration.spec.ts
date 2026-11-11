import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(30_000);

import { MikroORM } from '@mikro-orm/postgresql';
import type { ArgumentsHost, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { waitForInfrastructure } from '../../scripts/wait-for-infra';
import { AppModule } from '../../src/app.module';
import { LOGGER_PORT } from '../../src/application/index';
import type { JsonStructuredLogger } from '../../src/infrastructure/observability/json-structured-logger';
import { DomainExceptionFilter } from '../../src/presentation/http/filters/domain-exception.filter';

describe('DomainExceptionFilter — logs de erros de driver não vazam valores monetários (Postgres real)', () => {
  let app: INestApplication;
  let orm: MikroORM;
  let logger: JsonStructuredLogger;
  const lines: string[] = [];

  beforeAll(async () => {
    process.env.SQS_CONSUMER_ENABLED = 'false';
    process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
    process.env.PENDING_REF_WORKER_ENABLED = 'false';
    await waitForInfrastructure({ silent: true });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    orm = app.get(MikroORM);
    logger = app.get<JsonStructuredLogger>(LOGGER_PORT);
    logger.setSink((_level, raw) => {
      lines.push(raw);
    });
  });

  afterAll(async () => {
    Reflect.deleteProperty(process.env, 'SQS_CONSUMER_ENABLED');
    Reflect.deleteProperty(process.env, 'OUTBOX_PUBLISHER_ENABLED');
    Reflect.deleteProperty(process.env, 'PENDING_REF_WORKER_ENABLED');
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    lines.length = 0;
    const migrator = orm.getMigrator();
    await migrator.down({ to: 0 });
    await migrator.up();
  });

  it('erro real do driver (violação de constraint com valores 5.00/95.00) é logado de forma estruturada e sanitizada', async () => {
    let driverError: unknown;
    try {
      await orm.em
        .fork()
        .execute(
          `insert into wallets (id, player_id, currency, balance_amount) values ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'BRL', '-95.00')`,
        );
    } catch (error) {
      driverError = error;
    }
    expect(driverError).toBeInstanceOf(Error);
    // Sanidade: a mensagem bruta do driver realmente carrega o valor.
    expect((driverError as Error).message).toContain('95.00');

    const statusCalls: number[] = [];
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({
          setHeader: () => undefined,
          status: (code: number) => {
            statusCalls.push(code);
            return { json: () => undefined };
          },
        }),
      }),
    } as unknown as ArgumentsHost;

    const filter = new DomainExceptionFilter(logger);
    filter.catch(driverError, host);

    expect(statusCalls).toEqual([500]);
    const joined = lines.join('\n');
    expect(joined).toContain('unhandled_http_exception');
    expect(joined).not.toContain('95.00');
    expect(joined).not.toContain('5.00');
    expect(joined.toLowerCase()).not.toContain('values (');
    const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(parsed.errorName).toBeDefined();
  });
});
