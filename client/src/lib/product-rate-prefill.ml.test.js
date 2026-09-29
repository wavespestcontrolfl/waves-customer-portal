import { describe, expect, it } from 'vitest';
import { defaultApplicationMethodForLine, resolveRatePrefill } from './product-rate-prefill';

// The catalog keeps a label's own mL figure (migration 20260816000010: five
// Arborjet rows in ml/inch dbh, Palm-Jet in ml/palm, SUPERthrive and Bloom
// City Clean Kelp in ml/gal), but no completion form prefills or offers it
// (owner ruling 2026-09-27; every service 2026-09-29). Such a row starts with
// a blank rate and its amount in fl oz; the pest 4 oz house default still
// applies where it would, in oz.
const IMA_JET = {
  id: 'ima-jet', name: 'Arborjet Ima-Jet 10', category: 'insecticide',
  default_rate: '1-6', default_unit: 'ml/inch dbh', application_method: 'trunk_injection',
};
const PALM_JET = {
  id: 'palm-jet', name: 'Arborjet Palm-Jet Palm Nutrition',
  default_rate: '5-30', default_unit: 'ml/palm', application_method: 'trunk_injection',
};
const SUPERTHRIVE = {
  id: 'superthrive', name: 'SUPERthrive Foliage-Pro 9-3-6', category: 'fertilizer',
  default_rate: '1.25-5', default_unit: 'ml/gal',
};
const KELP = { id: 'kelp', name: 'Bloom City Clean Kelp', default_rate: '5-10', default_unit: 'ml/gal' };
const BARE_ML = { id: 'bare-ml', name: 'Example Liquid Supplement', rate_unit: 'ml', default_rate_per_1000: null };
const ML_PRODUCTS = [IMA_JET, PALM_JET, SUPERTHRIVE, KELP, BARE_ML];

const NO_ML_ROW = {
  rate: '', labelMaxRate: null, rateUnit: '', amountUnit: 'fl_oz',
  usePestSprayDefault: false, perBasisUnit: false, defaultUnit: '',
};
const HOUSE_DEFAULT_ROW = {
  rate: 4, labelMaxRate: null, rateUnit: 'oz', amountUnit: 'oz',
  usePestSprayDefault: true, perBasisUnit: false, defaultUnit: '',
};

const LINES = ['pest', 'lawn', 'tree_shrub', 'palm', 'mosquito', 'termite', 'rodent', ''];
const METHODS = [
  'perimeter_spray', 'broadcast_spray', 'spot_treatment', 'granular_broadcast', 'soil_drench', 'bait_placement',
  'station_check', 'fog_ulv', 'foliar_spray', 'trunk_injection', 'pin_stream', '',
];
const carriesMl = (result) => Object.values(result).some((value) => /\bml\b|millilit|\bcc\b/i.test(String(value)));

describe('resolveRatePrefill for a label rate kept in mL', () => {
  it.each([
    { product: IMA_JET, serviceLine: 'tree_shrub' },
    { product: PALM_JET, serviceLine: 'palm' },
    { product: SUPERTHRIVE, serviceLine: 'tree_shrub' },
    { product: KELP, serviceLine: 'tree_shrub' },
    { product: BARE_ML, serviceLine: 'lawn' },
  ])('$product.name starts with a blank rate and its amount in fl oz ($serviceLine)', ({ product, serviceLine }) => {
    const applicationMethod = defaultApplicationMethodForLine(product, serviceLine);
    expect(resolveRatePrefill(product, { applicationMethod, serviceLine })).toEqual(NO_ML_ROW);
  });

  it('never carries mL on any service line or method; only the pest perimeter house default fills a rate', () => {
    for (const product of ML_PRODUCTS) {
      for (const serviceLine of LINES) {
        for (const applicationMethod of METHODS) {
          const result = resolveRatePrefill(product, { applicationMethod, serviceLine });
          const where = `${product.name} · ${serviceLine || 'no line'} · ${applicationMethod || 'no method'}`;
          expect(carriesMl(result), where).toBe(false);
          expect(result, where).toEqual(
            serviceLine === 'pest' && applicationMethod === 'perimeter_spray' ? HOUSE_DEFAULT_ROW : NO_ML_ROW,
          );
        }
      }
    }
  });

  it('a pest perimeter spray labeled in mL starts at the 4 oz house default, with no mL anywhere', () => {
    const product = { id: 'spray', name: 'Example Insecticide SC', category: 'insecticide', default_rate: '6-24', default_unit: 'ml/gal' };
    const applicationMethod = defaultApplicationMethodForLine(product, 'pest');
    expect(applicationMethod).toBe('perimeter_spray');
    const result = resolveRatePrefill(product, { applicationMethod, serviceLine: 'pest' });
    expect(result).toEqual(HOUSE_DEFAULT_ROW);
    expect(carriesMl(result)).toBe(false);
  });

  it('reads the mL unit from any of the catalog fields, in any spelling', () => {
    for (const product of [
      { defaultUnit: 'mL/gal', defaultRate: '5-10' },
      { rateUnit: 'milliliters', defaultRatePer1000: '30' },
      { default_unit: 'cc', default_rate_per_1000: '30' },
      // A label unit in fl oz beside a catalog rate unit in mL is still an mL row.
      { default_unit: 'fl_oz/gal', default_rate: '0.5', rate_unit: 'ml' },
    ]) {
      expect(resolveRatePrefill(product, { applicationMethod: 'broadcast_spray', serviceLine: 'lawn' }), JSON.stringify(product))
        .toEqual(NO_ML_ROW);
    }
  });
});

describe('resolveRatePrefill for every other product', () => {
  const TAURUS = { id: 'taurus', name: 'Taurus SC', category: 'insecticide', default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' };

  it('keeps a fl oz label band and its ceiling', () => {
    expect(resolveRatePrefill(TAURUS, { applicationMethod: 'spot_treatment', serviceLine: 'pest' })).toEqual({
      rate: 0.2, labelMaxRate: 0.8, rateUnit: 'fl_oz/gal', amountUnit: 'fl_oz',
      usePestSprayDefault: false, perBasisUnit: true, defaultUnit: 'fl_oz/gal',
    });
    expect(resolveRatePrefill(TAURUS, { applicationMethod: 'perimeter_spray', serviceLine: 'pest' })).toEqual({
      rate: 4, labelMaxRate: 0.8, rateUnit: 'oz', amountUnit: 'oz',
      usePestSprayDefault: true, perBasisUnit: true, defaultUnit: 'fl_oz/gal',
    });
  });

  it('keeps a verified per-1,000 rate', () => {
    const product = { id: 'granular', name: 'Example Granular', default_rate_per_1000: '0.5000', rate_unit: 'lb' };
    expect(resolveRatePrefill(product, { applicationMethod: 'granular_broadcast', serviceLine: 'lawn' })).toEqual({
      rate: 0.5, labelMaxRate: null, rateUnit: 'lb', amountUnit: 'lb',
      usePestSprayDefault: false, perBasisUnit: false, defaultUnit: 'lb',
    });
  });
});
