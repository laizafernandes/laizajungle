import { describe, expect, it } from 'bun:test';
import { isPermanentPgError } from '../../src/application/services/validation.helpers';

describe('isPermanentPgError', () => {
  it('trata SQLSTATE 22001 (value too long) como permanente, inclusive aninhado em cause/driverError', () => {
    expect(isPermanentPgError(Object.assign(new Error('x'), { code: '22001' }))).toBe(true);
    expect(isPermanentPgError({ message: 'wrap', driverError: { code: '22001' } })).toBe(true);
    expect(isPermanentPgError({ cause: { code: '22001' } })).toBe(true);
  });

  it('não classifica como permanente erros transitórios ou desconhecidos', () => {
    expect(isPermanentPgError(Object.assign(new Error('x'), { code: '55P03' }))).toBe(false);
    expect(isPermanentPgError(Object.assign(new Error('x'), { code: '40P01' }))).toBe(false);
    expect(isPermanentPgError(new Error('boom'))).toBe(false);
    expect(isPermanentPgError(undefined)).toBe(false);
  });
});
