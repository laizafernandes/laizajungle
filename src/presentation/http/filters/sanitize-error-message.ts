const MAX_SANITIZED_LENGTH = 200;
const SQL_PREFIX = /^\s*(insert|update|delete|select|with)\b[\s\S]*?\s-\s(?=[A-Za-z])/i;

/**
 * Remove de mensagens de erro de driver (MikroORM/pg) qualquer trecho que possa conter
 * valores: o SQL com parâmetros inline, a linha `detail:` (ex.: "Failing row contains (...)"),
 * literais entre aspas simples e números decimais. Mantém só o motivo técnico (ex.: nome da constraint).
 */
export function sanitizeErrorMessage(message: string): string {
  const withoutSql = message.replace(SQL_PREFIX, '');
  const withoutDetail = withoutSql
    .split('\n')
    .filter((line) => !/^\s*-\s*detail:/i.test(line))
    .join(' ');
  return withoutDetail
    .replace(/'(?:[^']|'')*'/g, "'?'")
    .replace(/-?\b\d+\.\d+\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SANITIZED_LENGTH);
}

export function extractSqlState(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return undefined;
}
