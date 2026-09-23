import { describe, expect, it } from 'vitest';
import { isValidCronExpression, normalizeCronExpressions } from '../src/utils/cronValidation';

describe('Cron Trigger validation', () => {
  it('accepts Cloudflare five-field expressions and trims whitespace', () => {
    expect(isValidCronExpression('*/15 * * * *')).toBe(true);
    expect(isValidCronExpression('0 8 * * 1-5')).toBe(true);
    expect(isValidCronExpression('59 23 LW * *')).toBe(true);
    expect(isValidCronExpression('0 17 * * sun')).toBe(true);
    expect(isValidCronExpression('0 18 * * 6L')).toBe(true);
    expect(normalizeCronExpressions(['  0 0 1 * *  '])).toEqual(['0 0 1 * *']);
  });

  it('rejects malformed field counts and empty values', () => {
    expect(isValidCronExpression('0 8 * *')).toBe(false);
    expect(isValidCronExpression('0 8 * * * extra')).toBe(false);
    expect(isValidCronExpression('')).toBe(false);
    expect(normalizeCronExpressions(['0 0 * * *', 12])).toBeNull();
  });

  it('allows an empty list to clear all triggers', () => {
    expect(normalizeCronExpressions([])).toEqual([]);
  });
});
