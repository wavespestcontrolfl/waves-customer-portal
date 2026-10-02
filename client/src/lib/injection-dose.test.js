import { describe, expect, it } from 'vitest';
import {
  DOSE_UNITS, doseOverLabel, doseText, doseUnderLabel, injectionBand, injectionBasis, injectionDoseText, injectionLabelRate, injectionLabelText,
  bandKeyFor, injectionRecordView, parseDose, pickedBand, recordForProduct, recordWithBand, trunkInchesText,
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
const BANDED = [PHOSPHO_JET, MN_JET];
const NO_TABLE = [IMA_JET, IMA_JET_10, PALM_JET, PROPIZOL];

describe('injectionLabelRate', () => {
  it('reads an Arborjet label in mL per inch of trunk or per palm, with its band table when it has one', () => {
    expect(injectionLabelRate(PHOSPHO_JET)).toMatchObject({ low: 3.5, high: 7, basis: 'inch', pick: 'Plant' });
    expect(injectionLabelRate(PHOSPHO_JET).bands.map((band) => [band.key, band.palm || false])).toEqual([['tree', false], ['palm', true]]);
    expect(injectionLabelRate(PHOSPHO_JET).bands[0].sizes.map((size) => [size.low, size.high])).toEqual([[3.5, 3.5], [3.5, 5], [5, 7]]);
    expect(injectionLabelRate(MN_JET)).toMatchObject({ low: 5, high: 15, basis: 'inch', pick: 'Plant and season' });
    expect(injectionLabelRate(MN_JET).bands.map((band) => [band.key, band.low, band.high, band.palm || false])).toEqual([
      ['tree_low', 5, 5, false], ['tree_late', 10, 15, false], ['palm', undefined, undefined, true],
    ]);
  });

  it('has no band table for IMA-jet, IMA-jet 10, Palm-jet, Propizol, an unknown injectable, or a unit that does not match', () => {
    expect(injectionLabelRate(IMA_JET)).toMatchObject({ low: 2, high: 8, basis: 'inch', bands: null, pick: null });
    expect(injectionLabelRate(PALM_JET)).toMatchObject({ low: 5, high: 30, basis: 'palm', bands: null, pick: null });
    expect(injectionLabelRate(IMA_JET_10)).toMatchObject({ low: 1, high: 6, basis: 'inch', bands: null, pick: null });
    expect(injectionLabelRate(PROPIZOL).bands).toBeNull();
    expect(injectionLabelRate({ name: 'Some Injectable', default_rate: '1-6', default_unit: 'ml/inch dbh' }).bands).toBeNull();
    expect(injectionLabelRate({ ...PHOSPHO_JET, default_unit: 'ml/palm' }).bands).toBeNull();
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

describe('injectionBasis', () => {
  it('reads per inch or per palm from the unit, in mL or grams', () => {
    expect(injectionBasis(IMA_JET_10)).toBe('inch');
    expect(injectionBasis(PALM_JET)).toBe('palm');
    // Arbor-OTC's label is grams per inch: no liquid rate, still per inch.
    expect(injectionBasis({ default_rate: '0.28', default_unit: 'g/inch dbh' })).toBe('inch');
    expect(injectionLabelRate({ default_rate: '0.28', default_unit: 'g/inch dbh' })).toBeNull();
    expect(injectionBasis({ default_unit: 'ml/gal' })).toBeNull();
    expect(injectionBasis({ default_unit: 'oz/1000 sq ft' })).toBeNull();
  });
});

describe('the label band that applies', () => {
  it('waits for the tech to pick the plant, even when the trunk is known', () => {
    const rate = injectionLabelRate(PHOSPHO_JET);
    expect(injectionBand(rate, 10, '')).toBeNull();
    expect(injectionDoseText(rate, 10, '')).toBeNull();
    // A key from another label is no pick.
    expect(injectionBand(rate, 10, 'tree_low')).toBeNull();
    expect(pickedBand(rate, '')).toBeNull();
    expect(pickedBand(rate, 'tree')).toMatchObject({ key: 'tree' });
    expect(pickedBand(rate, 'palm')).toMatchObject({ key: 'palm', palm: true });
    expect(pickedBand(injectionLabelRate(IMA_JET), 'tree')).toBeNull();
  });

  it("splits PHOSPHO-jet's tree pick by the trunk, as its label does", () => {
    const rate = injectionLabelRate(PHOSPHO_JET);
    // The trunk is needed before the picked tree settles.
    expect(injectionBand(rate, '', 'tree')).toBeNull();
    expect(injectionBand(rate, 0, 'tree')).toBeNull();
    expect(injectionBand(rate, 11.9, 'tree')).toMatchObject({ key: 'tree', low: 3.5, high: 3.5 });
    expect(injectionBand(rate, 12, 'tree')).toMatchObject({ low: 3.5, high: 5 });
    expect(injectionBand(rate, 24, 'tree')).toMatchObject({ low: 3.5, high: 5 });
    expect(injectionBand(rate, 24.1, 'tree')).toMatchObject({ low: 5, high: 7 });
  });

  it('settles Mn-jet by the season picked, whatever the trunk', () => {
    const rate = injectionLabelRate(MN_JET);
    expect(injectionBand(rate, 10, '')).toBeNull();
    expect(injectionBand(rate, 10, 'tree_low')).toMatchObject({ low: 5, high: 5 });
    expect(injectionBand(rate, '', 'tree_low')).toMatchObject({ low: 5, high: 5 });
    expect(injectionBand(rate, 30, 'tree_late')).toMatchObject({ low: 10, high: 15 });
  });

  it('settles a palm pick as the palm band, with no dose', () => {
    for (const product of BANDED) {
      const rate = injectionLabelRate(product);
      expect(injectionBand(rate, 10, 'palm')).toMatchObject({ key: 'palm', palm: true });
      expect(injectionDoseText(rate, 10, 'palm')).toBeNull();
      expect(injectionDoseText(rate, '', 'palm')).toBeNull();
    }
  });

  it('works out no dose and has no band for a label with no table', () => {
    for (const product of NO_TABLE) {
      const rate = injectionLabelRate(product);
      expect(rate.bands).toBeNull();
      expect(injectionBand(rate, 10, '')).toBeNull();
      expect(injectionBand(rate, 10, 'tree')).toBeNull();
      expect(injectionDoseText(rate, 10, '')).toBeNull();
      expect(injectionDoseText(rate, '', '')).toBeNull();
    }
    expect(injectionLabelText(injectionLabelRate(IMA_JET_10))).toBe('¼ – 1 tsp per inch of trunk');
  });
});

describe('the rate and dose as the tech reads them', () => {
  it('reads the label per inch of trunk, or per palm, in spoons or ounces', () => {
    expect(injectionLabelText(injectionLabelRate(IMA_JET))).toBe('½ – 1½ tsp per inch of trunk');
    expect(injectionLabelText(injectionLabelRate(PALM_JET))).toMatch(/ fl oz per palm$/);
    const phospho = injectionLabelRate(PHOSPHO_JET);
    expect(injectionLabelText(phospho)).toBe('¾ – 1¼ tsp per inch of trunk');
    expect(injectionLabelText(phospho, injectionBand(phospho, 30, 'tree'))).toBe('1¼ tsp per inch of trunk');
    // A palm band has no per-inch rate of its own: the label's range reads.
    expect(injectionLabelText(phospho, phospho.bands[1])).toBe(injectionLabelText(phospho));
  });

  it('works out the dose for the trunk measured, from the picked tree and the trunk', () => {
    const phospho = injectionLabelRate(PHOSPHO_JET);
    // 10 in: 3.5 mL per inch only (35 mL); 18 in: 3.5-5 (63-90 mL); 30 in: 5-7.
    expect(injectionDoseText(phospho, 10, 'tree')).toBe('1.18 fl oz');
    expect(injectionDoseText(phospho, 18, 'tree')).toBe('2¼ – 3 fl oz');
    expect(injectionDoseText(phospho, 30, 'tree')).toBe('5¼ – 7 fl oz');
    expect(injectionDoseText(phospho, '', 'tree')).toBeNull();
    expect(injectionDoseText(phospho, 0, 'tree')).toBeNull();
    // Nothing without the pick.
    expect(injectionDoseText(phospho, 10, '')).toBeNull();
    // Mn-jet: the season's rate times the trunk.
    const mn = injectionLabelRate(MN_JET);
    expect(injectionDoseText(mn, 10, 'tree_low')).toBe('1.69 fl oz');
    expect(injectionDoseText(mn, '', 'tree_low')).toBeNull();
    expect(injectionDoseText(mn, 10, 'tree_late')).toBe('3½ – 5 fl oz');
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
// Every non-palm band of every banded label, at trunks 0.5-48 in.
const everyDose = (fn) => {
  for (const product of BANDED) {
    const rate = injectionLabelRate(product);
    for (const pick of rate.bands.filter((band) => !band.palm).map((band) => band.key)) {
      for (let tenths = 5; tenths <= 480; tenths += 1) {
        const inches = tenths / 10;
        const band = injectionBand(rate, inches, pick);
        const text = injectionDoseText(rate, inches, pick);
        expect(band, `${product.name} ${pick} at ${inches} in`).not.toBeNull();
        expect(text, `${product.name} ${pick} at ${inches} in`).not.toBeNull();
        fn({ product, rate, pick, inches, band, text, per: inches });
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
    expect(injectionDoseText(injectionLabelRate(PHOSPHO_JET), 10.5, 'tree')).toBe('1.24 fl oz');
    // Mn-jet's low rate at 10 in is 50 mL: 1½ fl oz would be 11% short.
    expect(injectionDoseText(injectionLabelRate(MN_JET), 10, 'tree_low')).toBe('1.69 fl oz');
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
    expect(doseUnderLabel(phospho, 10, 1, 'tsp', 'tree')).toBe(true);
    expect(doseUnderLabel(phospho, 10, 1.18, 'fl_oz', 'tree')).toBe(false);
    // 5% under the exact 35 mL (1.1835 fl oz) is the line, 1.124 fl oz.
    expect(doseUnderLabel(phospho, 10, 1.13, 'fl_oz', 'tree')).toBe(false);
    expect(doseUnderLabel(phospho, 10, 1.1, 'fl_oz', 'tree')).toBe(true);
    // Nothing to say until the band is settled: no pick, or no trunk.
    expect(doseUnderLabel(phospho, 10, 1, 'tsp', '')).toBe(false);
    expect(doseUnderLabel(phospho, '', 1, 'tsp', 'tree')).toBe(false);
    // Mn-jet's season rate.
    expect(doseUnderLabel(injectionLabelRate(MN_JET), 10, 1, 'fl_oz', 'tree_low')).toBe(true);
  });

  it('has nothing to say for a palm pick or a label with no table', () => {
    for (const product of BANDED) expect(doseUnderLabel(injectionLabelRate(product), 10, 1, 'tsp', 'palm')).toBe(false);
    expect(doseUnderLabel(injectionLabelRate(IMA_JET), 10, 1, 'tsp', '')).toBe(false);
    expect(doseUnderLabel(injectionLabelRate(PALM_JET), '', 1, 'tsp', '')).toBe(false);
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
  const phospho = injectionLabelRate(PHOSPHO_JET);
  const mn = injectionLabelRate(MN_JET);

  it("checks the dose against the band's exact limit for the trunk", () => {
    // PHOSPHO-jet tree of 10 in: 3.5 mL per inch only (35 mL, 1.18 fl oz).
    expect(doseOverLabel(phospho, 10, 1.18, 'fl_oz', 'tree')).toBe(false);
    expect(doseOverLabel(phospho, 10, 1.25, 'fl_oz', 'tree')).toBe(true);
    // 18 in: 5 mL per inch is the limit (90 mL, 3.04 fl oz).
    expect(doseOverLabel(phospho, 18, 3, 'fl_oz', 'tree')).toBe(false);
    expect(doseOverLabel(phospho, 18, 3.1, 'fl_oz', 'tree')).toBe(true);
    // 30 in: 7 mL per inch (210 mL, 7.1 fl oz).
    expect(doseOverLabel(phospho, 30, 7, 'fl_oz', 'tree')).toBe(false);
    expect(doseOverLabel(phospho, 30, 7.2, 'fl_oz', 'tree')).toBe(true);
    // Mn-jet: the low season allows 5 mL per inch, the late season 15.
    expect(doseOverLabel(mn, 10, 1.69, 'fl_oz', 'tree_low')).toBe(false);
    expect(doseOverLabel(mn, 10, 1.8, 'fl_oz', 'tree_low')).toBe(true);
    expect(doseOverLabel(mn, 10, 1.8, 'fl_oz', 'tree_late')).toBe(false);
    expect(doseOverLabel(mn, 10, 5.1, 'fl_oz', 'tree_late')).toBe(true);
  });

  it("falls back to the label's top rate until the band is settled", () => {
    // PHOSPHO-jet, no pick: 7 mL per inch of 10 in = 70 mL (2.37 fl oz).
    expect(doseOverLabel(phospho, 10, 2.3, 'fl_oz', '')).toBe(false);
    expect(doseOverLabel(phospho, 10, 2.4, 'fl_oz', '')).toBe(true);
    // A picked tree with no trunk yet: still the label's top rate.
    expect(doseOverLabel(phospho, 10, 2.4, 'fl_oz', 'tree')).toBe(true);
    // A label with no table: its display range's top.
    const imaJet = injectionLabelRate(IMA_JET);
    expect(doseOverLabel(imaJet, 10, 2.7, 'fl_oz', '')).toBe(false);
    expect(doseOverLabel(imaJet, 10, 2.75, 'fl_oz', '')).toBe(true);
  });

  it('never warns on a palm pick, whatever the dose or the size', () => {
    for (const rate of [phospho, mn]) {
      expect(doseOverLabel(rate, 10, 50, 'fl_oz', 'palm')).toBe(false);
      expect(doseOverLabel(rate, '', 50, 'fl_oz', 'palm')).toBe(false);
    }
  });

  it('checks a per-palm label (Palm-jet) against its label range per palm', () => {
    const palm = injectionLabelRate(PALM_JET);
    expect(doseOverLabel(palm, '', 1, 'fl_oz')).toBe(false);
    expect(doseOverLabel(palm, '', 1.02, 'fl_oz')).toBe(true);
    // Palm-jet has no band: nothing is too little.
    expect(doseUnderLabel(palm, '', 0.1, 'fl_oz', '')).toBe(false);
  });

  it('has nothing to say without a trunk size or a dose', () => {
    expect(doseOverLabel(phospho, '', 5, 'fl_oz', 'tree')).toBe(false);
    expect(doseOverLabel(phospho, 10, '', 'fl_oz', 'tree')).toBe(false);
  });
});

describe('the record and its product', () => {
  const products = [
    { name: PHOSPHO_JET.name, rate: injectionLabelRate(PHOSPHO_JET), basis: 'inch' },
    { name: IMA_JET.name, rate: injectionLabelRate(IMA_JET), basis: 'inch' },
  ];

  it('reads the band picked for this product only', () => {
    const record = { product: PHOSPHO_JET.name, sizeClassOrDbh: '10 in DBH', labelBand: { product: PHOSPHO_JET.name, key: 'tree' } };
    expect(injectionRecordView(record, products)).toMatchObject({ pickKey: 'tree', trunkInches: '10', trunkNeeded: true, doseRange: '1.18 fl oz' });
    expect(injectionRecordView({ ...record, labelBand: { product: 'Other', key: 'tree' } }, products)).toMatchObject({ pickKey: '', band: null, doseRange: null });
    expect(injectionRecordView({}, products)).toMatchObject({ pickKey: '', rate: null, doseRange: null });
    expect(bandKeyFor(record)).toBe('tree');
    expect(bandKeyFor({ ...record, labelBand: { product: 'Other', key: 'tree' } })).toBe('');
    expect(bandKeyFor({ product: PHOSPHO_JET.name })).toBe('');
  });

  it('needs the pick before the trunk settles a PHOSPHO-jet dose', () => {
    const record = { product: PHOSPHO_JET.name, sizeClassOrDbh: '18 in DBH' };
    expect(injectionRecordView(record, products)).toMatchObject({ pickKey: '', band: null, doseRange: null, trunkNeeded: true });
    expect(injectionRecordView({ ...record, labelBand: { product: PHOSPHO_JET.name, key: 'tree' } }, products).doseRange).toBe('2¼ – 3 fl oz');
  });

  it('needs no trunk, and shows no dose or limit, for a palm band', () => {
    const record = {
      product: PHOSPHO_JET.name, sizeClassOrDbh: 'Large palm', dose: '2 fl oz', labelBand: { product: PHOSPHO_JET.name, key: 'palm' },
    };
    const view = injectionRecordView(record, products);
    expect(view).toMatchObject({ pickKey: 'palm', trunkNeeded: false, trunkInches: '', doseRange: null, unreadableTrunk: '' });
    expect(view.band).toMatchObject({ palm: true });
    expect(view.overLabel('fl_oz')).toBe(false);
    expect(view.underLabel('fl_oz')).toBe(false);
    // The same size text on a tree pick is an unreadable trunk.
    expect(injectionRecordView({ ...record, labelBand: { product: PHOSPHO_JET.name, key: 'tree' } }, products)).toMatchObject({
      trunkNeeded: true, unreadableTrunk: 'Large palm',
    });
  });

  it('reads a label with no table with no band, no dose, and the trunk still needed per inch', () => {
    const view = injectionRecordView({ product: IMA_JET.name, sizeClassOrDbh: '10 in DBH', dose: '1 fl oz' }, products);
    expect(view).toMatchObject({ band: null, doseRange: null, trunkNeeded: true, trunkInches: '10', pickKey: '' });
    expect(view.overLabel('fl_oz')).toBe(false);
    expect(view.overLabel('tsp')).toBe(false);
    expect(view.underLabel('fl_oz')).toBe(false);
  });

  it('needs the trunk for a per-inch label with no rate (Arbor-OTC grams), and none for a per-palm one', () => {
    const arbor = [{ name: 'Arbor-OTC', rate: null, basis: 'inch' }, { name: 'Palm label', rate: null, basis: 'palm' }];
    expect(injectionRecordView({ product: 'Arbor-OTC' }, arbor)).toMatchObject({ basis: 'inch', trunkNeeded: true, doseRange: null });
    expect(injectionRecordView({ product: 'Palm label' }, arbor)).toMatchObject({ basis: 'palm', trunkNeeded: false });
  });

  it('finds the chosen product by catalog id before its name', () => {
    const byId = [{ productId: 'p-1', name: 'Renamed', rate: injectionLabelRate(PHOSPHO_JET), basis: 'inch' }];
    expect(injectionRecordView({ product: 'Old name', productId: 'p-1' }, byId).chosen).toBe(byId[0]);
    expect(injectionRecordView({ product: 'Old name', productId: 'p-2' }, byId).chosen).toBeNull();
  });

  it('starts a new product without the old dose and band, keeping the trunk', () => {
    const record = { product: PHOSPHO_JET.name, sizeClassOrDbh: '10 in DBH', dose: '1 fl oz', labelBand: { product: PHOSPHO_JET.name, key: 'tree' } };
    expect(recordForProduct(record, MN_JET.name, { productId: 'mn-1' })).toEqual({
      product: MN_JET.name, productId: 'mn-1', productAuto: false, sizeClassOrDbh: '10 in DBH', dose: '', labelBand: null,
    });
    expect(recordForProduct(record, PHOSPHO_JET.name, { productAuto: true })).toEqual({ ...record, productAuto: true, productId: null });
    // The same product keeps its band, dose and catalog id.
    expect(recordForProduct({ ...record, productId: 'pj-1' }, PHOSPHO_JET.name)).toEqual({ ...record, productAuto: false, productId: 'pj-1' });
    // A label measured another way starts without the old size.
    expect(recordForProduct(record, PALM_JET.name, { clearSize: true }).sizeClassOrDbh).toBe('');
    expect(recordForProduct(record, PALM_JET.name).sizeClassOrDbh).toBe('10 in DBH');
    // The old API's clearField is gone: it does nothing now.
    expect(recordForProduct({ product: PALM_JET.name, sizeClassOrDbh: 'Large palm' }, '', { clearField: 'sizeClassOrDbh' }).sizeClassOrDbh).toBe('Large palm');
  });

  it('saves the band picked, for the product it names', () => {
    expect(recordWithBand({ product: PHOSPHO_JET.name, sizeClassOrDbh: '10 in DBH' }, 'tree')).toEqual({
      product: PHOSPHO_JET.name, sizeClassOrDbh: '10 in DBH', labelBand: { product: PHOSPHO_JET.name, key: 'tree' },
    });
    // Another label's pick was for that label: the new pick replaces it.
    expect(recordWithBand({ product: MN_JET.name, labelBand: { product: PHOSPHO_JET.name, key: 'tree' } }, 'tree_low').labelBand).toEqual({ product: MN_JET.name, key: 'tree_low' });
  });

  it('starts the size over when the pick changes how it is measured (clearSize)', () => {
    const record = { product: PHOSPHO_JET.name, sizeClassOrDbh: '10 in DBH', labelBand: { product: PHOSPHO_JET.name, key: 'tree' } };
    expect(recordWithBand(record, 'palm', { clearSize: true })).toEqual({
      product: PHOSPHO_JET.name, sizeClassOrDbh: '', labelBand: { product: PHOSPHO_JET.name, key: 'palm' },
    });
    expect(recordWithBand(record, 'palm').sizeClassOrDbh).toBe('10 in DBH');
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
