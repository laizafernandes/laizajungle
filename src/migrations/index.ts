import type { MigrationObject } from '@mikro-orm/core';
import { Migration202611100001_InitialWageringSchema } from './Migration202611100001_InitialWageringSchema';

/**
 * Explicit registry of versioned, reversible database migrations.
 */
export const MIGRATIONS_LIST: MigrationObject[] = [
  {
    name: 'Migration202611100001_InitialWageringSchema',
    class: Migration202611100001_InitialWageringSchema,
  },
];
