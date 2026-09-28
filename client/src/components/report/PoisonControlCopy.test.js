import { describe, expect, it } from 'vitest';
import { applicatorIdLine } from './PoisonControlCopy';

describe('applicatorIdLine', () => {
  it('prints the name and ID card number, the number alone without a name, nothing without a number', () => {
    expect(applicatorIdLine('Adam', 'JE000001')).toBe('Applicator: Adam · FDACS ID card #JE000001');
    expect(applicatorIdLine('', 'JE000001')).toBe('Applicator FDACS ID card #JE000001');
    expect(applicatorIdLine('Adam', null)).toBeNull();
    expect(applicatorIdLine('Adam', '  ')).toBeNull();
  });
});
