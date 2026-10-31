import { describe, expect, it } from 'vitest';
import { mistingRefillLine } from './mistingPlanText';

describe('mistingRefillLine', () => {
  it('prints the owner wording with the yearly count', () => {
    expect(mistingRefillLine({ label: 'Standard solution', perFill: 129, refillsPerYear: 4 }))
      .toBe('Refills, Standard solution: $129.00 each. Billed when we refill the tank. We expect about 4 a year.');
  });

  it('drops the yearly sentence for 0, missing or non-whole counts', () => {
    for (const refillsPerYear of [0, null, undefined, -1, 2.5, 'x']) {
      expect(mistingRefillLine({ label: 'Premium solution', perFill: 319, refillsPerYear }))
        .toBe('Refills, Premium solution: $319.00 each. Billed when we refill the tank.');
    }
  });

  it('prints nothing without a refill price', () => {
    expect(mistingRefillLine(null)).toBeNull();
    expect(mistingRefillLine({ label: 'Standard solution' })).toBeNull();
    expect(mistingRefillLine({ label: 'Standard solution', perFill: 0 })).toBeNull();
  });
});
