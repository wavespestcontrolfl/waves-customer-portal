import { describe, expect, it } from 'vitest';
import {
  DOSE_UNITS, doseOverLabel, doseText, injectionBand, injectionDoseText, injectionLabelRate, injectionLabelText, parseDose, trunkInchesText,
} from './injection-dose';

// Owner ruling 2026-09-29: an injection is measured in tsp or fl oz like
// everything else. The catalog keeps each Arborjet label in mL per inch of
// trunk or per palm; the injection record never shows or takes mL.

const IMA_JET_10 = { name: 'Arborjet Ima-Jet 10', default_rate: '1-6', default_unit: 'ml/inch dbh' };
const PALM_JET = { name: 'Arborjet Palm-Jet Palm Nutrition', default_rate: '5-30', default_unit: 'ml/palm' };

const PHOSPHO_JET = { name: 'Arborjet PHOSPHO-Jet Systemic Fungicide', default_rate: '3.5-7', default_unit: 'ml/inch dbh' };
const IMA_JET = { name: 'Arborjet Ima-Jet Systemic Insecticide', default_rate: '2-8', default_unit: 'ml/inch dbh' };

describe('injectionLabelRate', () => {
  it('reads an Arborjet label in mL per inch of trunk or per palm, with its band table', () => {
    expect(injectionLabelRate(IMA_JET_10)).toMatchObject({ low: 1, high: 6, basis: 'inch', pick: 'Label rate' });
    expect(injectionLabelRate(IMA_JET_10).bands.map((band) => [band.low, band.high])).toEqual([[1, 2], [3, 6]]);
    expect(injectionLabelRate(IMA_JET).bands.map((band) => band.key)).toEqual(['aphids_scales', 'borers']);
    expect(injectionLabelRate(PHOSPHO_JET)).toMatchObject({ low: 3.5, high: 7, basis: 'inch', pick: null });
    expect(injectionLabelRate(PALM_JET)).toMatchObject({ low: 5, high: 30, basis: 'palm', pick: 'Palm size' });
    expect(injectionLabelRate({ defaultRate: '10', defaultUnit: 'mL/inch DBH' })).toMatchObject({ low: 10, high: 10, basis: 'inch', bands: null });
  });

  it('has no band table for an injectable it does not know, or a unit that does not match the table', () => {
    expect(injectionLabelRate({ name: 'Some Injectable', default_rate: '1-6', default_unit: 'ml/inch dbh' }).bands).toBeNull();
    expect(injectionLabelRate({ ...PALM_JET, default_unit: 'ml/inch dbh' }).bands).toBeNull();
  });

  it('is null for any other label', () => {
    expect(injectionLabelRate({ default_rate: '5-10', default_unit: 'ml/gal' })).toBeNull();
    expect(injectionLabelRate({ default_rate: '0.2-0.8', default_unit: 'fl_oz/gal' })).toBeNull();
    expect(injectionLabelRate({ default_rate: 'see label', default_unit: 'ml/inch dbh' })).toBeNull();
    expect(injectionLabelRate({})).toBeNull();
    expect(injectionLabelRate(null)).toBeNull();
  });
});

describe('the label band that applies', () => {
  it('waits for the tech to pick a band the label splits by pest, season or palm size', () => {
    const rate = injectionLabelRate(IMA_JET_10);
    expect(injectionBand(rate, 10, '')).toBeNull();
    expect(injectionDoseText(rate, 10, '')).toBeNull();
    expect(injectionBand(rate, 10, 'low')).toMatchObject({ low: 1, high: 2 });
  });

  it('picks a size-banded label by the trunk', () => {
    const rate = injectionLabelRate(PHOSPHO_JET);
    expect(injectionBand(rate, '', '')).toBeNull();
    expect(injectionBand(rate, 11.9, '')).toMatchObject({ key: 'under_12' });
    expect(injectionBand(rate, 12, '')).toMatchObject({ key: '12_up' });
  });

  it('works out no dose for an injectable with no band table', () => {
    const rate = injectionLabelRate({ name: 'Some Injectable', default_rate: '1-6', default_unit: 'ml/inch dbh' });
    expect(injectionDoseText(rate, 10, '')).toBeNull();
    expect(injectionLabelText(rate)).toBe('¼ – 1 tsp per inch of trunk');
  });
});

describe('the rate and dose as the tech reads them', () => {
  it('reads the label per inch of trunk, or per palm, in spoons or ounces', () => {
    const rate = injectionLabelRate(IMA_JET_10);
    expect(injectionLabelText(rate)).toBe('¼ – 1 tsp per inch of trunk');
    expect(injectionLabelText(rate, rate.bands[0])).toBe('¼ tsp per inch of trunk');
    expect(injectionLabelText(injectionLabelRate(PALM_JET))).toMatch(/ fl oz per palm$/);
  });

  it('works out the dose for the trunk measured, from the band', () => {
    const rate = injectionLabelRate(IMA_JET_10);
    // 10 in on the low rate: 10-20 mL, never the label's 60 mL top.
    expect(injectionDoseText(rate, 10, 'low')).toBe('2¼ – 4 tsp');
    expect(injectionDoseText(rate, 10, 'high')).toBe('1¼ – 2 fl oz');
    expect(injectionDoseText(rate, '', 'low')).toBeNull();
    expect(injectionDoseText(rate, 0, 'low')).toBeNull();
    // PHOSPHO-jet under 12 in is one rate: 3.5 mL per inch.
    expect(injectionDoseText(injectionLabelRate(PHOSPHO_JET), 10, '')).not.toMatch(/ – /);
    // Per palm, whatever the palm's trunk.
    const palm = injectionLabelRate(PALM_JET);
    expect(injectionDoseText(palm, '', 'small')).toBe(injectionDoseText(palm, 40, 'small'));
  });

  it('never reads mL', () => {
    for (const product of [IMA_JET_10, IMA_JET, PHOSPHO_JET, PALM_JET]) {
      const rate = injectionLabelRate(product);
      expect(injectionLabelText(rate)).not.toMatch(/\bml\b/i);
      for (const band of rate.bands) {
        for (const inches of [2, 6, 10, 24]) expect(injectionDoseText(rate, inches, band.key) || '').not.toMatch(/\bml\b/i);
      }
    }
  });
});

describe('the shown range stays inside the label band', () => {
  const ML_PER_FL_OZ = 29.5735;
  const AMOUNT = /^(≈ )?(\d*)([⅛¼⅜½⅝¾⅞]?)(\.\d+)?$/;
  const FRACTION = { '': 0, '⅛': 0.125, '¼': 0.25, '⅜': 0.375, '½': 0.5, '⅝': 0.625, '¾': 0.75, '⅞': 0.875 };
  const toMl = (amount, unit) => {
    const m = AMOUNT.exec(amount.trim());
    if (!m) throw new Error(`unreadable amount "${amount}"`);
    const n = Number(m[2] || 0) + FRACTION[m[3]] + Number(m[4] || 0);
    return (unit === 'tsp' ? n / 6 : n) * ML_PER_FL_OZ;
  };
  const shownMl = (text) => {
    const [, ends, unit] = /^(.+) (tsp|fl oz)$/.exec(text);
    return ends.split(' – ').map((end) => toMl(end, unit));
  };

  it('never shows an end outside the exact band limits, for any trunk', () => {
    for (const product of [IMA_JET_10, IMA_JET, PHOSPHO_JET, { name: 'Arborjet Propizol', default_rate: '10-20', default_unit: 'ml/inch dbh' },
      { name: 'ArborJet Mn-Jet Fe Micros', default_rate: '5-15', default_unit: 'ml/inch dbh' }, PALM_JET]) {
      const rate = injectionLabelRate(product);
      for (const pick of rate.bands.map((band) => band.key)) {
        for (let inches = 1; inches <= 48; inches += 1) {
          const band = injectionBand(rate, inches, pick);
          const text = injectionDoseText(rate, inches, pick);
          const per = rate.basis === 'palm' ? 1 : inches;
          const ends = shownMl(text);
          // Display rounds to 3 places at most; allow that and nothing more.
          const slack = 0.0005 * ML_PER_FL_OZ;
          for (const ml of ends) {
            expect(ml, `${product.name} ${pick} at ${inches} in: ${text}`).toBeLessThanOrEqual(band.high * per + slack);
            if (ends.length > 1) expect(ml, `${product.name} ${pick} at ${inches} in: ${text}`).toBeGreaterThanOrEqual(band.low * per - slack);
          }
        }
      }
    }
  });

  it('reads a single-rate band as one amount', () => {
    const rate = injectionLabelRate({ name: 'ArborJet Mn-Jet Fe Micros', default_rate: '5-15', default_unit: 'ml/inch dbh' });
    expect(injectionLabelText(rate, rate.bands[0])).toBe('1 tsp per inch of trunk');
    expect(injectionDoseText(rate, 10, 'low')).toBe('≈ 1½ fl oz');
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

  it('checks against the band once it is settled', () => {
    // 10 in on the low rate (1-2 mL per inch): the limit is 20 mL, not 60.
    expect(doseOverLabel(rate, 10, 4, 'tsp', 'low')).toBe(false);
    expect(doseOverLabel(rate, 10, 1, 'fl_oz', 'low')).toBe(true);
    expect(doseOverLabel(rate, 10, 1, 'fl_oz', 'high')).toBe(false);
    // A PHOSPHO-jet tree under 12 in: 3.5 mL per inch is the limit.
    const phospho = injectionLabelRate(PHOSPHO_JET);
    expect(doseOverLabel(phospho, 10, 1.2, 'fl_oz')).toBe(true);
    expect(doseOverLabel(phospho, 14, 1.2, 'fl_oz')).toBe(false);
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
