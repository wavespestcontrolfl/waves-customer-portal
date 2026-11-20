import { describe, expect, it } from 'vitest';
import { prefillRateCeiling, resolveRatePrefill } from './product-rate-prefill';

// The label ceiling a prefilled rate is reviewed against (the recap editor and
// the Fast Complete sheet): never for the pest house default.

const TAURUS = { name: 'Taurus SC', category: 'Insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' };
const PER_1000 = {
  name: 'Fixture lawn liquid', category: 'Fertilizer', rate_unit: 'fl_oz',
  default_rate_per_1000: '0.75', max_label_rate_per_1000: '1.5',
};

describe('prefillRateCeiling', () => {
  it('has no ceiling for the pest house default, whatever the label basis', () => {
    const resolved = resolveRatePrefill(TAURUS, { applicationMethod: 'perimeter_spray', serviceLine: 'pest' });
    expect(resolved).toMatchObject({ rate: 1.6, rateUnit: 'oz', usePestSprayDefault: true, perBasisUnit: true, labelMaxRate: 0.8 });
    expect(prefillRateCeiling(resolved, TAURUS)).toBeNull();
  });

  it('starts a house-mix product at the mix\'s own amount and any other liquid pest product at 4', () => {
    // The same figures the house mix records as totals (lib/pest-default-mix.js), so a row's rate and total agree.
    const perimeter = { applicationMethod: 'perimeter_spray', serviceLine: 'pest' };
    const crosscheck = { name: 'LESCO Crosscheck Plus', category: 'Insecticide' };
    const other = { name: 'Fixture pest liquid', category: 'Insecticide' };
    expect(resolveRatePrefill(TAURUS, perimeter)).toMatchObject({ rate: 1.6, rateUnit: 'oz', amountUnit: 'oz' });
    expect(resolveRatePrefill(crosscheck, perimeter)).toMatchObject({ rate: 4, rateUnit: 'oz', usePestSprayDefault: true });
    expect(resolveRatePrefill(other, perimeter)).toMatchObject({ rate: 4, rateUnit: 'oz', usePestSprayDefault: true });
    expect(prefillRateCeiling(resolveRatePrefill(crosscheck, perimeter), crosscheck)).toBeNull();
    // A catalog rate still wins over the house default, house-mix product or not.
    expect(resolveRatePrefill({ ...TAURUS, default_rate_per_1000: '0.5' }, perimeter)).toMatchObject({ rate: 0.5, usePestSprayDefault: false });
  });

  it('reviews a per-basis rate against its label band\'s upper bound', () => {
    const resolved = resolveRatePrefill(TAURUS, { applicationMethod: 'spot_treatment', serviceLine: 'pest' });
    expect(resolved).toMatchObject({ rate: 0.2, rateUnit: 'fl_oz/gal', usePestSprayDefault: false });
    expect(prefillRateCeiling(resolved, TAURUS)).toBe(0.8);
  });

  it('reviews a per-1,000 rate against the verified catalog max', () => {
    const resolved = resolveRatePrefill(PER_1000, { applicationMethod: 'broadcast_spray', serviceLine: 'lawn' });
    expect(prefillRateCeiling(resolved, PER_1000)).toBe(1.5);
  });

  it('has no ceiling when the catalog records none', () => {
    const product = { ...PER_1000, max_label_rate_per_1000: null };
    const resolved = resolveRatePrefill(product, { applicationMethod: 'broadcast_spray', serviceLine: 'lawn' });
    expect(prefillRateCeiling(resolved, product)).toBeNull();
  });
});
