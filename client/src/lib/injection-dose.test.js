import { describe, expect, it } from 'vitest';
import {
  DOSE_UNITS, doseText, injectionLabelRate, injectionLabelText, injectionRecordView, parseDose, recordForProduct, trunkInchesText,
} from './injection-dose';

// Owner ruling 2026-09-29: an injection is measured in tsp or fl oz like
// everything else. The catalog keeps each Arborjet label in mL per inch of
// trunk or per palm; the injection record never shows or takes mL.

const IMA_JET_10 = { name: 'Arborjet Ima-Jet 10', default_rate: '1-6', default_unit: 'ml/inch dbh' };
const PHOSPHO_JET = { name: 'Arborjet PHOSPHO-Jet Systemic Fungicide', default_rate: '3.5-7', default_unit: 'ml/inch dbh' };
const PALM_JET = { name: 'Arborjet Palm-Jet Palm Nutrition', default_rate: '5-30', default_unit: 'ml/palm' };

describe('injectionLabelRate', () => {
  it('reads an Arborjet label in mL per inch of trunk or per palm', () => {
    expect(injectionLabelRate(IMA_JET_10)).toEqual({ low: 1, high: 6, basis: 'inch' });
    expect(injectionLabelRate(PHOSPHO_JET)).toEqual({ low: 3.5, high: 7, basis: 'inch' });
    expect(injectionLabelRate(PALM_JET)).toEqual({ low: 5, high: 30, basis: 'palm' });
    expect(injectionLabelRate({ defaultRate: '10', defaultUnit: 'mL/inch DBH' })).toEqual({ low: 10, high: 10, basis: 'inch' });
  });

  it('is null for any other label', () => {
    expect(injectionLabelRate({ default_rate: '5-10', default_unit: 'ml/gal' })).toBeNull();
    expect(injectionLabelRate({ default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' })).toBeNull();
    expect(injectionLabelRate({ ...PHOSPHO_JET, default_rate: 'see label' })).toBeNull();
    expect(injectionLabelRate({ ...PHOSPHO_JET, default_rate: '' })).toBeNull();
    expect(injectionLabelRate({})).toBeNull();
    expect(injectionLabelRate(null)).toBeNull();
  });
});

describe('the label as the tech reads it', () => {
  it('reads per inch of trunk, or per palm, in spoons or ounces', () => {
    expect(injectionLabelText(injectionLabelRate(IMA_JET_10))).toBe('¼ – 1 tsp per inch of trunk');
    expect(injectionLabelText(injectionLabelRate(PALM_JET))).toMatch(/ fl oz per palm$/);
  });

  it('reads a single-rate label as one amount, never more than 5% under it', () => {
    // 10 mL is 2.03 tsp: 2 tsp is within 5%.
    expect(injectionLabelText(injectionLabelRate({ default_rate: '10', default_unit: 'ml/inch dbh' }))).toBe('2 tsp per inch of trunk');
    // 36.75 mL (1.24 fl oz): "≈ 1 fl oz" would be 19.5% short.
    expect(injectionLabelText(injectionLabelRate({ default_rate: '36.75', default_unit: 'ml/palm' }))).toBe('1.24 fl oz per palm');
  });

  it('never reads mL', () => {
    for (const product of [IMA_JET_10, PHOSPHO_JET, PALM_JET, { default_rate: '10-20', default_unit: 'ml/inch dbh' }]) {
      expect(injectionLabelText(injectionLabelRate(product))).not.toMatch(/\bml\b/i);
    }
  });
});

describe('the record and its product', () => {
  const products = [
    { name: IMA_JET_10.name, productId: 'ij-10', rate: injectionLabelRate(IMA_JET_10) },
    { name: PHOSPHO_JET.name, productId: 'pj-1', rate: injectionLabelRate(PHOSPHO_JET) },
  ];

  it('finds the product by catalog id, else by name', () => {
    expect(injectionRecordView({ product: 'Old name', productId: 'pj-1' }, products).chosen.name).toBe(PHOSPHO_JET.name);
    expect(injectionRecordView({ product: IMA_JET_10.name }, products).chosen.productId).toBe('ij-10');
    expect(injectionRecordView({ product: 'Tree-age' }, products)).toMatchObject({ chosen: null, rate: null });
  });

  it('reads the trunk and dose, and the saved values it cannot read', () => {
    expect(injectionRecordView({ product: PHOSPHO_JET.name, sizeClassOrDbh: '10 in DBH', dose: '1 fl oz' }, products)).toMatchObject({
      trunkInches: '10', dose: { amount: '1', unit: 'fl_oz' }, unreadableTrunk: '', unreadableDose: '',
    });
    expect(injectionRecordView({ product: PHOSPHO_JET.name, sizeClassOrDbh: '30 cm DBH', dose: 'a squirt' }, products)).toMatchObject({
      trunkInches: '', unreadableTrunk: '30 cm DBH', unreadableDose: 'a squirt',
    });
  });

  it('starts a new product without the old dose, keeping the trunk', () => {
    const record = { product: IMA_JET_10.name, productId: 'ij-10', sizeClassOrDbh: '10 in DBH', dose: '1 fl oz' };
    expect(recordForProduct(record, PHOSPHO_JET.name, { productId: 'pj-1' })).toEqual({
      product: PHOSPHO_JET.name, productId: 'pj-1', productAuto: false, sizeClassOrDbh: '10 in DBH', dose: '',
    });
    expect(recordForProduct(record, IMA_JET_10.name, { productAuto: true })).toEqual({ ...record, productAuto: true });
  });
});

describe('the stored dose and trunk size', () => {
  it('stores a dose as a number of tsp or fl oz, and reads it back', () => {
    expect(DOSE_UNITS.map((unit) => unit.value)).toEqual(['tsp', 'fl_oz']);
    expect(doseText('1', 'fl_oz')).toBe('1 fl oz');
    expect(doseText('1.5', 'tsp')).toBe('1.5 tsp');
    expect(doseText('', 'tsp')).toBe('');
    expect(parseDose('1 fl oz')).toEqual({ amount: '1', unit: 'fl_oz' });
    expect(parseDose('1.5 tsp')).toEqual({ amount: '1.5', unit: 'tsp' });
    // A dot typed mid-number, or first, survives the round trip.
    expect(parseDose(doseText('2.', 'tsp'))).toEqual({ amount: '2.', unit: 'tsp' });
    expect(parseDose(doseText('.', 'tsp'))).toEqual({ amount: '.', unit: 'tsp' });
    expect(parseDose(doseText('.5', 'fl_oz'))).toEqual({ amount: '.5', unit: 'fl_oz' });
    // A dose typed before this form reads when it is a number of tsp or fl oz,
    // fractions and unit words included.
    expect(parseDose('½ fl oz')).toEqual({ amount: '0.5', unit: 'fl_oz' });
    expect(parseDose('1½ tsp')).toEqual({ amount: '1.5', unit: 'tsp' });
    expect(parseDose('1 1/2 tsp')).toEqual({ amount: '1.5', unit: 'tsp' });
    expect(parseDose('2 teaspoons')).toEqual({ amount: '2', unit: 'tsp' });
    expect(parseDose('3 oz')).toEqual({ amount: '3', unit: 'fl_oz' });
    // Anything else reads empty, for the tech to enter again.
    expect(parseDose('20 mL')).toEqual({ amount: '', unit: '' });
    expect(parseDose('a squirt')).toEqual({ amount: '', unit: '' });
    expect(parseDose('fl oz')).toEqual({ amount: '', unit: '' });
  });

  it('reads the trunk inches back from the stored size', () => {
    expect(trunkInchesText('10 in DBH')).toBe('10');
    expect(trunkInchesText('12.5 in DBH')).toBe('12.5');
    expect(trunkInchesText('Large palm')).toBe('');
    // Only inches read as inches; another unit is entered again.
    expect(trunkInchesText('10')).toBe('10');
    expect(trunkInchesText('10 in')).toBe('10');
    expect(trunkInchesText('10 inches DBH')).toBe('10');
    expect(trunkInchesText('10"')).toBe('10');
    expect(trunkInchesText('30 cm DBH')).toBe('');
    expect(trunkInchesText('25 mm')).toBe('');
    expect(trunkInchesText('10 ft tall')).toBe('');
    expect(trunkInchesText('')).toBe('');
  });
});
