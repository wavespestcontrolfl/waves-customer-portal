import { describe, expect, it } from 'vitest';
import { PEST_DEFAULT_MIX, isPestDefaultMixVisit } from './pest-default-mix';

describe('isPestDefaultMixVisit: trap-only retainer plans (owner 2026-11-19)', () => {
  it.each([
    'Monthly Trap-Only Retainer Service',
    'Trap-Only Retainer Plus',
    'Trap-Only Retainer Standard',
  ])('"%s" gets no pest house mix', (serviceType) => {
    expect(isPestDefaultMixVisit({ serviceType })).toBe(false);
  });

  it.each([
    'Monthly Pest Control Service',
    'Quarterly Pest Control Service',
    'One-Time Pest Control Service',
    'Pest Control Re-Service',
  ])('"%s" still gets the pest house mix', (serviceType) => {
    expect(isPestDefaultMixVisit({ serviceType })).toBe(true);
  });

  it('the house mix itself is unchanged: Taurus SC 4, Crosscheck 4, surfactant 0.25', () => {
    expect(PEST_DEFAULT_MIX.map((entry) => entry.totalAmount)).toEqual([4, 4, 0.25]);
  });
});
