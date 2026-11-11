import type { MigrationObject } from '@mikro-orm/core';
import { Migration202611100001_InitialWageringSchema } from './Migration202611100001_InitialWageringSchema';
import { Migration202611110002_InboxAndOutboxSchema } from './Migration202611110002_InboxAndOutboxSchema';

/**
 * Explicit registry of versioned, reversible database migrations.
 */
export const MIGRATIONS_LIST: MigrationObject[] = [
  {
    name: 'Migration202611100001_InitialWageringSchema',
    class: Migration202611100001_InitialWageringSchema,
  },
  {
    name: 'Migration202611110002_InboxAndOutboxSchema',
    class: Migration202611110002_InboxAndOutboxSchema,
  },
];
