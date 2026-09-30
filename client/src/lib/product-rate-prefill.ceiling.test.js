import { describe, expect, it } from 'vitest';
import { prefillRateCeiling, resolveRatePrefill } from './product-rate-prefill';

// The label ceiling a prefilled rate is reviewed against (the recap editor and
// the Fast Complete sheet): never for the 4-oz pest house default.

const TAURUS = { name: 'Taurus SC', category: 'Insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' };
const PER_1000 = {
  name: 'Fixture lawn liquid', category: 'Fertilizer', rate_unit: 'fl_oz',
  default_rate_per_1000: '0.75', max_label_rate_per_1000: '1.5',
};

describe('prefillRateCeiling', () => {
  it('has no ceiling for the pest house default, whatever the label basis', () => {
    const resolved = resolveRatePrefill(TAURUS, { applicationMethod: 'perimeter_spray', serviceLine: 'pest' });
    expect(resolved).toMatchObject({ rate: 4, rateUnit: 'oz', usePestSprayDefault: true, perBasisUnit: true, labelMaxRate: 0.8 });
    expect(prefillRateCeiling(resolved, TAURUS)).toBeNull();
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
