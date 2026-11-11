import { Migrator } from '@mikro-orm/migrations';
import { type Options, defineConfig } from '@mikro-orm/postgresql';
import { MIGRATIONS_LIST } from '../../migrations/index';
import { loadEnvConfig } from '../config/env.config';
import { WagerTransactionOrmEntity } from './entities/wager-transaction.orm-entity';
import { WalletLedgerEntryOrmEntity } from './entities/wallet-ledger-entry.orm-entity';
import { WalletOrmEntity } from './entities/wallet.orm-entity';

export function buildMikroOrmOptions(env: NodeJS.ProcessEnv = process.env): Options {
  const config = loadEnvConfig(env);

  return defineConfig({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    dbName: config.db.name,
    entities: [WalletOrmEntity, WagerTransactionOrmEntity, WalletLedgerEntryOrmEntity],
    discovery: {
      warnWhenNoEntities: false,
    },
    allowGlobalContext: false,
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      migrationsList: MIGRATIONS_LIST,
    },
    pool: {
      min: config.db.poolMin,
      max: config.db.poolMax,
    },
  });
}

export default buildMikroOrmOptions();
