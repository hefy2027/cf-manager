import { describe, expect, it } from 'vitest';
import { isValidCronExpression, normalizeCronExpressions } from '../utils/cronValidation';

describe('Cron Trigger validation (worker)', () => {
  it('accepts five-field expressions and trims whitespace', () => {
    expect(isValidCronExpression('*/15 * * * *')).toBe(true);
    expect(isValidCronExpression('0 8 * * 1-5')).toBe(true);
    expect(isValidCronExpression('59 23 LW * *')).toBe(true);
    expect(isValidCronExpression('0 17 * * sun')).toBe(true);
    expect(normalizeCronExpressions(['  0 0 1 * *  '])).toEqual(['0 0 1 * *']);
  });

  it('rejects malformed field counts while allowing an empty clear list', () => {
    expect(isValidCronExpression('0 8 * *')).toBe(false);
    expect(isValidCronExpression('0 8 * * * extra')).toBe(false);
    expect(isValidCronExpression('')).toBe(false);
    expect(normalizeCronExpressions(['0 0 * * *', 12])).toBeNull();
    expect(normalizeCronExpressions([])).toEqual([]);
  });
});
