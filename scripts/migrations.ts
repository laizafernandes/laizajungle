import { MikroORM } from '@mikro-orm/postgresql';
import { buildMikroOrmOptions } from '../src/infrastructure/database/mikro-orm.config';

async function runMigrationsCli(): Promise<void> {
  const action = process.argv[2] ?? 'up';
  const orm = await MikroORM.init(buildMikroOrmOptions());

  try {
    const migrator = orm.getMigrator();
    if (action === 'up') {
      const executed = await migrator.up();
      console.log(`[migrations:up] Executed ${executed.length} migration(s).`);
    } else if (action === 'down') {
      const reverted = await migrator.down();
      console.log(`[migrations:down] Reverted ${reverted.length} migration(s).`);
    } else if (action === 'status') {
      const executed = await migrator.getExecutedMigrations();
      const pending = await migrator.getPendingMigrations();
      console.log(
        JSON.stringify({
          executed: executed.map((m) => m.name),
          pending: pending.map((m) => m.name),
        }),
      );
    } else {
      throw new Error(`Unsupported migration action: ${action}. Expected: up | down | status`);
    }
  } finally {
    await orm.close(true);
  }
}

if (import.meta.main) {
  runMigrationsCli().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
