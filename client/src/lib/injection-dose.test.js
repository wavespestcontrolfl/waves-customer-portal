import { describe, expect, it } from 'vitest';
import {
  DOSE_UNITS, doseOverLabel, doseText, injectionDoseText, injectionLabelRate, injectionLabelText, parseDose, trunkInchesText,
} from './injection-dose';

// Owner ruling 2026-09-29: an injection is measured in tsp or fl oz like
// everything else. The catalog keeps each Arborjet label in mL per inch of
// trunk or per palm; the injection record never shows or takes mL.

const IMA_JET_10 = { default_rate: '1-6', default_unit: 'ml/inch dbh' };
const PALM_JET = { default_rate: '5-30', default_unit: 'ml/palm' };

describe('injectionLabelRate', () => {
  it('reads an Arborjet label in mL per inch of trunk or per palm', () => {
    expect(injectionLabelRate(IMA_JET_10)).toEqual({ low: 1, high: 6, basis: 'inch' });
    expect(injectionLabelRate({ default_rate: '3.5-7', default_unit: 'ml/inch dbh' })).toEqual({ low: 3.5, high: 7, basis: 'inch' });
    expect(injectionLabelRate(PALM_JET)).toEqual({ low: 5, high: 30, basis: 'palm' });
    expect(injectionLabelRate({ defaultRate: '10', defaultUnit: 'mL/inch DBH' })).toEqual({ low: 10, high: 10, basis: 'inch' });
  });

  it('is null for any other label', () => {
    expect(injectionLabelRate({ default_rate: '5-10', default_unit: 'ml/gal' })).toBeNull();
    expect(injectionLabelRate({ default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' })).toBeNull();
    expect(injectionLabelRate({ default_rate: 'see label', default_unit: 'ml/inch dbh' })).toBeNull();
    expect(injectionLabelRate({})).toBeNull();
    expect(injectionLabelRate(null)).toBeNull();
  });
});

describe('the rate and dose as the tech reads them', () => {
  it('reads the label per inch of trunk, or per palm, in spoons or ounces', () => {
    expect(injectionLabelText(injectionLabelRate(IMA_JET_10))).toBe('¼ – 1 tsp per inch of trunk');
    expect(injectionLabelText(injectionLabelRate(PALM_JET))).toMatch(/ fl oz per palm$/);
  });

  it('works out the dose for the trunk measured', () => {
    const rate = injectionLabelRate(IMA_JET_10);
    // 4 in: 4-24 mL is 1 - 4¾ tsp, rounded inside the label.
    expect(injectionDoseText(rate, 4)).toBe('1 – 4¾ tsp');
    expect(injectionDoseText(rate, '10')).toMatch(/ fl oz$/);
    expect(injectionDoseText(rate, '')).toBeNull();
    expect(injectionDoseText(rate, 0)).toBeNull();
    // Per palm, whatever the palm's size.
    const palm = injectionLabelRate(PALM_JET);
    expect(injectionDoseText(palm, '')).toBe(injectionDoseText(palm, 40));
  });

  it('never reads mL', () => {
    for (const product of [IMA_JET_10, PALM_JET, { default_rate: '10-20', default_unit: 'ml/inch dbh' }]) {
      const rate = injectionLabelRate(product);
      expect(injectionLabelText(rate)).not.toMatch(/\bml\b/i);
      for (const inches of [2, 6, 10, 24]) expect(injectionDoseText(rate, inches)).not.toMatch(/\bml\b/i);
    }
  });
});

describe('doseOverLabel', () => {
  // 10-inch trunk at 1-6 mL per inch: the label allows up to 60 mL (2.03 fl oz).
  const rate = injectionLabelRate(IMA_JET_10);

  it('checks the dose against the label\'s exact limit for the trunk', () => {
    expect(doseOverLabel(rate, 10, 2, 'fl_oz')).toBe(false);
    expect(doseOverLabel(rate, 10, 12, 'tsp')).toBe(false);
    expect(doseOverLabel(rate, 10, 2.03, 'fl_oz')).toBe(true);
    expect(doseOverLabel(rate, 10, 13, 'tsp')).toBe(true);
    expect(doseOverLabel(rate, 10, 3, 'fl_oz')).toBe(true);
  });

  it('checks a palm dose per palm', () => {
    const palm = injectionLabelRate(PALM_JET);
    expect(doseOverLabel(palm, '', 1, 'fl_oz')).toBe(false);
    expect(doseOverLabel(palm, '', 1.02, 'fl_oz')).toBe(true);
  });

  it('has nothing to say without a trunk size or a dose', () => {
    expect(doseOverLabel(rate, '', 5, 'fl_oz')).toBe(false);
    expect(doseOverLabel(rate, 10, '', 'fl_oz')).toBe(false);
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
    expect(trunkInchesText('')).toBe('');
  });
});
