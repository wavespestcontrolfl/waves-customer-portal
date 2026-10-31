import { describe, it, expect } from 'vitest';
import { annualPrepayCadenceOptionsFor } from './AdminInvoicesPage';

const values = (options) => options.map((option) => option.value);

describe('annual prepay cadence options — lawn rounds', () => {
  it('offers the rounds option only when the current or loaded cadence is lawn_rounds_9', () => {
    expect(values(annualPrepayCadenceOptionsFor('quarterly', null))).not.toContain('lawn_rounds_9');
    expect(values(annualPrepayCadenceOptionsFor('lawn_rounds_9', null))).toContain('lawn_rounds_9');
  });

  it('keeps the rounds option after the operator picks another cadence on a rounds term', () => {
    const options = annualPrepayCadenceOptionsFor('monthly', 'lawn_rounds_9');
    expect(values(options)).toContain('lawn_rounds_9');
    expect(options.find((option) => option.value === 'lawn_rounds_9').label).toBe('Lawn rounds (9 a year)');
    // Listed right after every-6-weeks.
    expect(values(options).indexOf('lawn_rounds_9')).toBe(values(options).indexOf('every_6_weeks') + 1);
  });
});
