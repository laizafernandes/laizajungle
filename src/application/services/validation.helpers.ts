const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export interface PgUniqueViolationShape {
  code?: string;
  constraint?: string;
  message?: string;
}

export function extractPgUniqueConstraint(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const visited = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const candidate = current as PgUniqueViolationShape & {
      cause?: unknown;
      previous?: unknown;
      driverError?: unknown;
    };

    if (candidate.code === '23505') {
      return candidate.constraint ?? candidate.message ?? '23505';
    }

    current = candidate.cause ?? candidate.previous ?? candidate.driverError;
  }

  return undefined;
}

/** Limites alinhados às colunas varchar do schema (Migration202611100001_InitialWageringSchema). */
export const FIELD_MAX_LENGTH = {
  providerId: 100,
  idempotencyKey: 255,
  externalTransactionId: 255,
  roundId: 255,
  gameId: 255,
  referenceExternalTransactionId: 255,
} as const;

const PERMANENT_PG_SQLSTATES: ReadonlySet<string> = new Set(['22001']);

/**
 * Erros de driver que nunca serão resolvidos por retentativa (ex.: 22001 value too long):
 * percorre cause/previous/driverError como extractPgUniqueConstraint.
 */
export function isPermanentPgError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const candidate = current as {
      code?: unknown;
      cause?: unknown;
      previous?: unknown;
      driverError?: unknown;
    };
    if (typeof candidate.code === 'string' && PERMANENT_PG_SQLSTATES.has(candidate.code)) {
      return true;
    }
    current = candidate.cause ?? candidate.previous ?? candidate.driverError;
  }
  return false;
}
