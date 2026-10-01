import { describe, expect, it } from 'vitest';
import {
  DOSE_UNITS, doseOverLabel, doseText, doseUnderLabel, injectionBand, injectionDoseText, injectionLabelRate, injectionLabelText,
  injectionRecordView, parseDose, recordForProduct, recordWithBand, trunkInchesText,
} from './injection-dose';

// Owner ruling 2026-09-29: an injection is measured in tsp or fl oz like
// everything else. The catalog keeps each Arborjet label in mL per inch of
// trunk or per palm; the injection record never shows or takes mL. Owner
// rulings 2026-10-01: the dose is worked out from the label's own bands, only
// for labels read in full (shared/injection-label-bands.json).

const IMA_JET_10 = { name: 'Arborjet Ima-Jet 10', default_rate: '1-6', default_unit: 'ml/inch dbh' };
const IMA_JET = { name: 'Arborjet Ima-Jet Systemic Insecticide', default_rate: '2-8', default_unit: 'ml/inch dbh' };
const PHOSPHO_JET = { name: 'Arborjet PHOSPHO-Jet Systemic Fungicide', default_rate: '3.5-7', default_unit: 'ml/inch dbh' };
const MN_JET = { name: 'ArborJet Mn-Jet Fe Micros', default_rate: '5-15', default_unit: 'ml/inch dbh' };
const PALM_JET = { name: 'Arborjet Palm-Jet Palm Nutrition', default_rate: '5-30', default_unit: 'ml/palm' };
const PROPIZOL = { name: 'Arborjet Propizol Injectable Fungicide', default_rate: '10-20', default_unit: 'ml/inch dbh' };
const BANDED = [IMA_JET, PHOSPHO_JET, MN_JET, PALM_JET];

describe('injectionLabelRate', () => {
  it('reads an Arborjet label in mL per inch of trunk or per palm, with its band table', () => {
    expect(injectionLabelRate(IMA_JET)).toMatchObject({ low: 2, high: 8, basis: 'inch', pick: 'Target pest' });
    expect(injectionLabelRate(IMA_JET).bands.map((band) => [band.key, band.low, band.high])).toEqual([
      ['sap_feeders', 2, 4], ['sap_feeders_severe', 4, 4], ['borers', 4, 8], ['borers_severe', 8, 8],
    ]);
    expect(injectionLabelRate(IMA_JET).note).toMatch(/under 12 in use the lower rate/);
    expect(injectionLabelRate(PHOSPHO_JET)).toMatchObject({ basis: 'inch', pick: null });
    expect(injectionLabelRate(PHOSPHO_JET).bands.map((band) => [band.low, band.high])).toEqual([[3.5, 3.5], [3.5, 5], [5, 7]]);
    expect(injectionLabelRate(MN_JET).bands.map((band) => [band.low, band.high])).toEqual([[5, 5], [10, 15]]);
    expect(injectionLabelRate(PALM_JET)).toMatchObject({ low: 5, high: 30, basis: 'palm', pick: 'Palm size' });
  });

  it('has no band table for a label not read in full, an unknown injectable, or a unit that does not match', () => {
    expect(injectionLabelRate(IMA_JET_10)).toMatchObject({ low: 1, high: 6, basis: 'inch', bands: null, pick: null });
    expect(injectionLabelRate(PROPIZOL).bands).toBeNull();
    expect(injectionLabelRate({ name: 'Some Injectable', default_rate: '1-6', default_unit: 'ml/inch dbh' }).bands).toBeNull();
    expect(injectionLabelRate({ ...PALM_JET, default_unit: 'ml/inch dbh' }).bands).toBeNull();
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

describe('the label band that applies', () => {
  it('waits for the tech to pick a band the label splits by pest, season or palm size', () => {
    const rate = injectionLabelRate(IMA_JET);
    expect(injectionBand(rate, 10, '')).toBeNull();
    expect(injectionDoseText(rate, 10, '')).toBeNull();
    expect(injectionBand(rate, 10, 'sap_feeders')).toMatchObject({ low: 2, high: 2 });
  });

  it("applies IMA-jet's trunk rule inside the picked target group", () => {
    const rate = injectionLabelRate(IMA_JET);
    // Under 12 in: the lower rate; 12 to 24 in: the range; over 24 in: the highest.
    expect(injectionBand(rate, 10, 'sap_feeders')).toMatchObject({ low: 2, high: 2 });
    expect(injectionBand(rate, 18, 'sap_feeders')).toMatchObject({ low: 2, high: 4 });
    expect(injectionBand(rate, 30, 'sap_feeders')).toMatchObject({ low: 4, high: 4 });
    expect(injectionBand(rate, 10, 'borers')).toMatchObject({ low: 4, high: 4 });
    expect(injectionBand(rate, 30, 'borers')).toMatchObject({ low: 8, high: 8 });
    // A severe infestation takes the highest rate at any size.
    expect(injectionBand(rate, 10, 'sap_feeders_severe')).toMatchObject({ low: 4, high: 4 });
    expect(injectionBand(rate, 10, 'borers_severe')).toMatchObject({ low: 8, high: 8 });
    // The trunk is needed before a size-split group settles.
    expect(injectionBand(rate, '', 'sap_feeders')).toBeNull();
  });

  it("picks PHOSPHO-jet's band by the trunk, as its label does", () => {
    const rate = injectionLabelRate(PHOSPHO_JET);
    expect(injectionBand(rate, '', '')).toBeNull();
    expect(injectionBand(rate, 11.9, '')).toMatchObject({ key: 'under_12' });
    expect(injectionBand(rate, 12, '')).toMatchObject({ key: '12_to_24' });
    expect(injectionBand(rate, 24, '')).toMatchObject({ key: '12_to_24' });
    expect(injectionBand(rate, 24.1, '')).toMatchObject({ key: 'over_24' });
  });

  it('works out no dose for a label not read in full', () => {
    for (const product of [IMA_JET_10, PROPIZOL]) {
      const rate = injectionLabelRate(product);
      expect(injectionDoseText(rate, 10, '')).toBeNull();
    }
    expect(injectionLabelText(injectionLabelRate(IMA_JET_10))).toBe('¼ – 1 tsp per inch of trunk');
  });
});

describe('the rate and dose as the tech reads them', () => {
  it('reads the label per inch of trunk, or per palm, in spoons or ounces', () => {
    const rate = injectionLabelRate(IMA_JET);
    expect(injectionLabelText(rate)).toBe('½ – 1½ tsp per inch of trunk');
    expect(injectionLabelText(rate, rate.bands[0])).toBe('½ – ¾ tsp per inch of trunk');
    expect(injectionLabelText(injectionLabelRate(PALM_JET))).toMatch(/ fl oz per palm$/);
  });

  it('works out the dose for the trunk measured, from the band', () => {
    const phospho = injectionLabelRate(PHOSPHO_JET);
    // 10 in: 3.5 mL per inch only (35 mL); 18 in: 3.5-5 (63-90 mL); 30 in: 5-7.
    expect(injectionDoseText(phospho, 10, '')).toBe('1.18 fl oz');
    expect(injectionDoseText(phospho, 18, '')).toBe('2¼ – 3 fl oz');
    expect(injectionDoseText(phospho, 30, '')).toBe('5¼ – 7 fl oz');
    const imaJet = injectionLabelRate(IMA_JET);
    // 10 in for sap feeders: the lower rate only, 20 mL.
    expect(injectionDoseText(imaJet, 10, 'sap_feeders')).toBe('4 tsp');
    expect(injectionDoseText(imaJet, '', 'sap_feeders')).toBeNull();
    expect(injectionDoseText(imaJet, 0, 'sap_feeders')).toBeNull();
    // Per palm, whatever the palm's trunk.
    const palm = injectionLabelRate(PALM_JET);
    expect(injectionDoseText(palm, '', 'small')).toBe(injectionDoseText(palm, 40, 'small'));
  });

  it('never reads mL', () => {
    for (const product of BANDED) {
      const rate = injectionLabelRate(product);
      expect(injectionLabelText(rate)).not.toMatch(/\bml\b/i);
      for (const band of rate.bands) {
        for (const inches of [2, 6, 10, 24]) expect(injectionDoseText(rate, inches, band.key) || '').not.toMatch(/\bml\b/i);
      }
    }
  });
});

const ML_PER_FL_OZ = 29.5735;
const AMOUNT = /^(≈ )?(\d*)([⅛¼⅜½⅝¾⅞]?)(\.\d+)?$/;
const FRACTION = { '': 0, '⅛': 0.125, '¼': 0.25, '⅜': 0.375, '½': 0.5, '⅝': 0.625, '¾': 0.75, '⅞': 0.875 };
const readAmount = (amount) => {
  const m = AMOUNT.exec(amount.trim());
  if (!m) throw new Error(`unreadable amount "${amount}"`);
  return Number(m[2] || 0) + FRACTION[m[3]] + Number(m[4] || 0);
};
const shownMl = (text) => {
  const [, ends, unit] = /^(.+) (tsp|fl oz)$/.exec(text);
  return ends.split(' – ').map((end) => (unit === 'tsp' ? readAmount(end) / 6 : readAmount(end)) * ML_PER_FL_OZ);
};
// Every band of every banded label, at trunks 0.5-48 in.
const everyDose = (fn) => {
  for (const product of BANDED) {
    const rate = injectionLabelRate(product);
    for (const pick of rate.bands.map((band) => band.key)) {
      for (let tenths = 5; tenths <= 480; tenths += 1) {
        const inches = tenths / 10;
        const band = injectionBand(rate, inches, pick);
        const text = injectionDoseText(rate, inches, pick);
        if (band && text) fn({ product, rate, pick, inches, band, text, per: rate.basis === 'palm' ? 1 : inches });
      }
    }
  }
};

describe('the shown dose stays inside the label band', () => {
  const slack = 0.0005 * ML_PER_FL_OZ;

  it('never shows an end outside the exact band limits, for any trunk', () => {
    everyDose(({ product, pick, inches, band, text, per }) => {
      const ends = shownMl(text);
      for (const ml of ends) {
        expect(ml, `${product.name} ${pick} at ${inches} in: ${text}`).toBeLessThanOrEqual(band.high * per + slack);
        if (ends.length > 1) expect(ml, `${product.name} ${pick} at ${inches} in: ${text}`).toBeGreaterThanOrEqual(band.low * per - slack);
      }
    });
  });

  it('never shows a single-rate dose more than 5% under it', () => {
    // PHOSPHO-jet at 10.5 in is 36.75 mL: never "≈ 1 fl oz" (29.6 mL).
    expect(injectionDoseText(injectionLabelRate(PHOSPHO_JET), 10.5, '')).toBe('1.24 fl oz');
    // Mn-jet's low rate at 10 in is 50 mL: 1½ fl oz would be 11% short.
    expect(injectionDoseText(injectionLabelRate(MN_JET), 10, 'low')).toBe('1.69 fl oz');
    everyDose(({ band, text, per, inches }) => {
      if (band.low !== band.high) return;
      const [shown] = shownMl(text);
      expect(shown, `${inches} in: ${text}`).toBeGreaterThanOrEqual(band.low * per * 0.95 - 1e-9);
    });
  });

  it('never warns on the top of the dose it suggests', () => {
    everyDose(({ product, rate, pick, inches, text }) => {
      const [, ends, unit] = /^(.+) (tsp|fl oz)$/.exec(text);
      const top = readAmount(ends.split(' – ').pop());
      expect(doseOverLabel(rate, inches, top, unit === 'tsp' ? 'tsp' : 'fl_oz', pick), `${product.name} ${pick} ${inches} in: ${text}`).toBe(false);
    });
  });
});

describe('doseUnderLabel', () => {
  it('notes a dose under the band, allowing the 5% the suggestion rounds down', () => {
    const phospho = injectionLabelRate(PHOSPHO_JET);
    // 10 in: 35 mL. 1 tsp (4.9 mL) is far under; the suggested 1.18 fl oz is not.
    expect(doseUnderLabel(phospho, 10, 1, 'tsp', '')).toBe(true);
    expect(doseUnderLabel(phospho, 10, 1.18, 'fl_oz', '')).toBe(false);
    // Nothing to say until the band is settled.
    expect(doseUnderLabel(injectionLabelRate(IMA_JET), 10, 1, 'tsp', '')).toBe(false);
  });

  it('never notes the bottom of the dose it suggests', () => {
    everyDose(({ product, rate, pick, inches, text }) => {
      const [, ends, unit] = /^(.+) (tsp|fl oz)$/.exec(text);
      const bottom = readAmount(ends.split(' – ')[0]);
      expect(doseUnderLabel(rate, inches, bottom, unit === 'tsp' ? 'tsp' : 'fl_oz', pick), `${product.name} ${pick} ${inches} in: ${text}`).toBe(false);
    });
  });
});

describe('doseOverLabel', () => {
  const imaJet = injectionLabelRate(IMA_JET);

  it("checks the dose against the band's exact limit for the trunk", () => {
    // 10 in for sap feeders: the lower rate, 20 mL (0.676 fl oz).
    expect(doseOverLabel(imaJet, 10, 4, 'tsp', 'sap_feeders')).toBe(false);
    expect(doseOverLabel(imaJet, 10, 1.25, 'fl_oz', 'sap_feeders')).toBe(true);
    // A severe infestation allows the highest rate: 40 mL.
    expect(doseOverLabel(imaJet, 10, 1.25, 'fl_oz', 'sap_feeders_severe')).toBe(false);
    // 18 in for sap feeders: up to 72 mL (2.43 fl oz).
    expect(doseOverLabel(imaJet, 18, 2.4, 'fl_oz', 'sap_feeders')).toBe(false);
    expect(doseOverLabel(imaJet, 18, 2.5, 'fl_oz', 'sap_feeders')).toBe(true);
    // A PHOSPHO-jet tree of 18 in: 5 mL per inch is the limit (90 mL, 3.04 fl oz).
    const phospho = injectionLabelRate(PHOSPHO_JET);
    expect(doseOverLabel(phospho, 18, 3, 'fl_oz')).toBe(false);
    expect(doseOverLabel(phospho, 18, 3.1, 'fl_oz')).toBe(true);
  });

  it("falls back to the label's top rate until the band is settled", () => {
    expect(doseOverLabel(imaJet, 10, 2.7, 'fl_oz', '')).toBe(false);
    expect(doseOverLabel(imaJet, 10, 2.75, 'fl_oz', '')).toBe(true);
  });

  it('checks a palm dose per palm', () => {
    const palm = injectionLabelRate(PALM_JET);
    expect(doseOverLabel(palm, '', 1, 'fl_oz', 'large')).toBe(false);
    expect(doseOverLabel(palm, '', 1.02, 'fl_oz', 'large')).toBe(true);
    expect(doseOverLabel(palm, '', 0.5, 'fl_oz', 'small')).toBe(true);
  });

  it('has nothing to say without a trunk size or a dose', () => {
    expect(doseOverLabel(imaJet, '', 5, 'fl_oz', 'sap_feeders')).toBe(false);
    expect(doseOverLabel(imaJet, 10, '', 'fl_oz', 'sap_feeders')).toBe(false);
  });
});

describe('the record and its product', () => {
  it('reads the band picked for this product only', () => {
    const products = [{ name: IMA_JET.name, rate: injectionLabelRate(IMA_JET) }];
    const record = { product: IMA_JET.name, sizeClassOrDbh: '10 in DBH', labelBand: { product: IMA_JET.name, key: 'sap_feeders' } };
    expect(injectionRecordView(record, products)).toMatchObject({ pickKey: 'sap_feeders', trunkInches: '10', doseRange: '4 tsp' });
    expect(injectionRecordView({ ...record, labelBand: { product: 'Other', key: 'sap_feeders' } }, products).pickKey).toBe('');
    expect(injectionRecordView({}, products)).toMatchObject({ pickKey: '', rate: null, doseRange: null });
  });

  it('starts a new product without the old dose and band, keeping the trunk', () => {
    const record = { product: IMA_JET.name, sizeClassOrDbh: '10 in DBH', dose: '1 fl oz', labelBand: { product: IMA_JET.name, key: 'sap_feeders' } };
    expect(recordForProduct(record, PHOSPHO_JET.name, { productId: 'pj-1' })).toEqual({
      product: PHOSPHO_JET.name, productId: 'pj-1', productAuto: false, sizeClassOrDbh: '10 in DBH', dose: '', labelBand: null,
    });
    expect(recordForProduct(record, IMA_JET.name, { productAuto: true })).toEqual({ ...record, productAuto: true, productId: null });
    // A field the old label's band answered (palm size, target pest) goes with it.
    expect(recordForProduct({ product: PALM_JET.name, sizeClassOrDbh: 'Small palm (6 to 12 ft spread)' }, '', { clearField: 'sizeClassOrDbh' }).sizeClassOrDbh).toBe('');
  });

  it("makes a palm band the record's palm size", () => {
    const palm = injectionLabelRate(PALM_JET);
    expect(recordWithBand({ product: PALM_JET.name }, palm, 'medium')).toEqual({
      product: PALM_JET.name, labelBand: { product: PALM_JET.name, key: 'medium' }, sizeClassOrDbh: 'Medium palm (12 to 24 ft spread)',
    });
    // IMA-jet's group is the record's target pest; the trunk stays.
    const ima = recordWithBand({ product: IMA_JET.name, sizeClassOrDbh: '10 in DBH' }, injectionLabelRate(IMA_JET), 'sap_feeders');
    expect(ima).toMatchObject({ sizeClassOrDbh: '10 in DBH', targetIssue: 'Aphids, scales, whiteflies and other sap feeders' });
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
    expect(trunkInchesText('Large palm (24 to 48 ft spread)')).toBe('');
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
