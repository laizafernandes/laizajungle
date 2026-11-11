import type { LogFields, StructuredLoggerPort } from '../../application/index';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogSink = (level: LogLevel, serializedLine: string) => void;

export interface JsonStructuredLoggerOptions {
  sink?: LogSink;
}

const SENSITIVE_OR_FINANCIAL_KEYS = new Set([
  'amount',
  'money',
  'balance',
  'resultingbalance',
  'initialbalance',
  'storedbalance',
  'calculatedbalance',
  'difference',
  'balancebefore',
  'balanceafter',
  'authorization',
  'password',
  'secret',
  'token',
  'apikey',
  'payload',
  'body',
  'rawbody',
  'credentials',
  'cookie',
  'setcookie',
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_OR_FINANCIAL_KEYS.has(key.replace(/[_-]/g, '').toLowerCase());
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || value === undefined) {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }

  if (typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key) || entry === undefined) {
        continue;
      }
      clean[key] = sanitizeValue(entry, depth + 1);
    }
    return clean;
  }

  return value;
}

export class JsonStructuredLogger implements StructuredLoggerPort {
  private sink: LogSink;

  constructor(options: JsonStructuredLoggerOptions = {}) {
    this.sink =
      options.sink ??
      ((level, line) => {
        if (level === 'error') {
          console.error(line);
        } else if (level === 'warn') {
          console.warn(line);
        } else {
          console.log(line);
        }
      });
  }

  setSink(sink: LogSink): void {
    this.sink = sink;
  }

  info(event: string, fields: LogFields = {}): void {
    this.emit('info', event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.emit('warn', event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.emit('error', event, fields);
  }

  private emit(level: LogLevel, event: string, fields: LogFields): void {
    const sanitized = sanitizeValue(fields) as Record<string, unknown>;
    const record: Record<string, unknown> = {
      level,
      event,
      timestamp: new Date().toISOString(),
      ...sanitized,
    };
    this.sink(level, JSON.stringify(record));
  }
}
