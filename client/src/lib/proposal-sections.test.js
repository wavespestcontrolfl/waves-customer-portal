import { describe, expect, it } from 'vitest';
import { commercialTermRows } from './proposal-sections';

const ALL = {
  paymentTerms: 'net30', initialTermMonths: 12, renewal: 'Auto-renews yearly', priceAdjustment: 'At renewal',
  cancellation: '30 days notice', accessRequirements: 'Keys at the desk',
};
const labels = (rows) => rows.map(([label]) => label);

describe('commercialTermRows', () => {
  it('lists every authored term in order, as before', () => {
    expect(labels(commercialTermRows(ALL))).toEqual(['Payment', 'Initial term', 'Renewal', 'Price adjustment', 'Cancellation', 'Property access']);
    expect(commercialTermRows(null)).toEqual([]);
  });

  it('keeps every row for a recurring proposal or when no option is passed', () => {
    expect(commercialTermRows(ALL, { recurring: true })).toEqual(commercialTermRows(ALL));
    expect(commercialTermRows(ALL, {})).toEqual(commercialTermRows(ALL));
  });

  it('drops the four fixed terms for a one-time-only proposal and keeps Payment and Property access', () => {
    expect(commercialTermRows(ALL, { recurring: false })).toEqual([['Payment', 'Net-30'], ['Property access', 'Keys at the desk']]);
    expect(commercialTermRows({ renewal: 'Auto-renews yearly' }, { recurring: false })).toEqual([]);
    expect(commercialTermRows(null, { recurring: false })).toEqual([]);
  });
});
