// GATE_TS_NEONIC_CAP rules (pure). Synthetic data only; the same numbers as the server's
// tree-shrub-neonic-ledger.test.js (a quarter acre of bed: Zylam 19.725 fl oz, Safari 10.8 oz, Merit 6.4 fl oz a year).
import { describe, expect, test } from 'vitest';
import { convertAmount, evaluateNeonicCap, formatEntered, formatLeft } from './tree-shrub-neonic-cap';

const ZYLAM_CAP = { productId: 'zylam', name: 'Zylam', unit: 'fl_oz', yearlyAmount: 19.725, remainingAmount: 19.725 };
const SAFARI_CAP = { productId: 'safari', name: 'Safari', unit: 'oz', yearlyAmount: 10.8, remainingAmount: 10.8 };
const MERIT_CAP = { productId: 'merit', name: 'Merit', unit: 'fl_oz', yearlyAmount: 6.4, remainingAmount: 6.4 };
const context = ({ dino = 0, imi = 0, unsized = 0, ...rest } = {}) => ({
  available: true,
  year: 2026,
  bedSqft: 10890,
  ingredients: [
    { key: 'dinotefuran', usedShare: dino, capByProduct: [ZYLAM_CAP, SAFARI_CAP], unsized, reason: null },
    { key: 'imidacloprid', usedShare: imi, capByProduct: [MERIT_CAP], unsized: 0, reason: null },
  ],
  ...rest,
});
const row = (productId, totalAmount, amountUnit, active = true) => ({ productId, name: productId, active, totalAmount, amountUnit });

describe('convertAmount', () => {
  test('converts within a measure and refuses across measures', () => {
    expect(convertAmount(1, 'gal', 'fl_oz')).toBe(128);
    expect(convertAmount(1, 'lb', 'oz')).toBe(16);
    expect(convertAmount(2, 'oz', 'oz')).toBe(2);
    expect(convertAmount(1, 'gal', 'lb')).toBeNull();
    expect(convertAmount(1, 'each', 'oz')).toBeNull();
    expect(convertAmount('', 'oz', 'oz')).toBeNull();
    expect(convertAmount(0, 'oz', 'oz')).toBeNull();
  });
});

describe('formatting never understates an overage', () => {
  test('entered rounds up, left rounds down, one decimal from 1 up and two below', () => {
    expect(formatEntered(4.74)).toBe('4.8');
    expect(formatLeft(4.725)).toBe('4.7');
    expect(formatLeft(0.2999)).toBe('0.29');
    expect(formatEntered(0.301)).toBe('0.31');
    expect(formatEntered(2)).toBe('2.0');
    expect(formatLeft(0)).toBe('0.00');
  });
});

describe('evaluateNeonicCap', () => {
  test('gate off or a failed read: nothing shows, nothing holds', () => {
    for (const ctx of [null, undefined, {}, { available: false, reason: 'ledger_unavailable', ingredients: [] }]) {
      expect(evaluateNeonicCap(ctx, [row('zylam', 99, 'fl_oz')])).toEqual({ lines: {}, holds: [], blockMessage: '' });
    }
  });

  test('a capped product shows what is left of its yearly amount; a product with no cap shows nothing', () => {
    const out = evaluateNeonicCap(context({ dino: 0.5 }), [row('zylam', '', 'fl_oz'), row('snapshot', 5, 'lb')]);
    expect(out.lines).toEqual({ zylam: 'Zylam left this year: 9.8 fl oz of 19.7' });
    expect(out.blockMessage).toBe('');
  });

  test('only active rows count', () => {
    const out = evaluateNeonicCap(context(), [row('zylam', 99, 'fl_oz', false)]);
    expect(out).toEqual({ lines: {}, holds: [], blockMessage: '' });
  });

  test('an amount over what is left holds Complete with the product, the amount and what is left', () => {
    const out = evaluateNeonicCap(context({ dino: 15 / 19.725 }), [row('zylam', 5, 'fl_oz')]);
    expect(out.blockMessage).toBe('Zylam: 5.0 fl oz is over the 4.7 fl oz left this year for this property.');
    expect(out.lines.zylam).toBe('Zylam left this year: 4.7 fl oz of 19.7');
  });

  test('an entered amount in a unit that does not convert holds Complete, never skips the check', () => {
    const out = evaluateNeonicCap(context({ dino: 0 }), [row('zylam', 999, 'each')]);
    expect(out.blockMessage).toBe('Zylam: enter the amount in fl oz so the yearly limit can be checked.');
    // No amount yet is the sheet's own "enter the amount" hold, not this one.
    expect(evaluateNeonicCap(context({ dino: 0 }), [row('zylam', '', 'fl_oz')]).blockMessage).toBe('');
  });

  test('an amount on the cap exactly does not hold', () => {
    expect(evaluateNeonicCap(context({ dino: 15 / 19.725 }), [row('zylam', 4.725, 'fl_oz')]).blockMessage).toBe('');
  });

  test('tsp and gal convert (a tsp amount goes as fl oz, as the server receives it)', () => {
    // 6 tsp = 1 fl oz; 12 tsp = 2 fl oz against 1.4 left.
    const out = evaluateNeonicCap(context({ dino: (19.725 - 1.4) / 19.725 }), [row('zylam', 12, 'tsp')]);
    expect(out.blockMessage).toBe('Zylam: 2.0 fl oz is over the 1.4 fl oz left this year for this property.');
    expect(evaluateNeonicCap(context(), [row('zylam', 1, 'gal')]).holds).toHaveLength(1);
  });

  test('Safari shares the dinotefuran cap with Zylam used earlier, and with a Zylam row on this visit', () => {
    const earlier = evaluateNeonicCap(context({ dino: 0.75 }), [row('safari', 3, 'oz')]);
    expect(earlier.blockMessage).toBe('Safari: 3.0 oz is over the 2.7 oz left this year for this property.');
    const together = evaluateNeonicCap(context(), [row('zylam', 12, 'fl_oz'), row('safari', 5, 'oz')]);
    expect(together.holds).toHaveLength(2);
    // Each line counts the other row: 5 oz of Safari is 0.463 of the year, so 0.537 of Zylam's 19.725 is left.
    expect(together.lines.zylam).toBe('Zylam left this year: 10.5 fl oz of 19.7');
  });

  test('lb of Safari converts to oz', () => {
    const inside = evaluateNeonicCap(context(), [row('safari', 0.6, 'lb')]);
    expect(inside.holds).toEqual([]);
    // The line is what is left before this row's own amount.
    expect(inside.lines.safari).toBe('Safari left this year: 10.8 oz of 10.8');
    expect(evaluateNeonicCap(context(), [row('safari', 0.7, 'lb')]).blockMessage).toBe('Safari: 11.2 oz is over the 10.8 oz left this year for this property.');
  });

  test('Merit is its own cap: a full dinotefuran year does not hold Merit', () => {
    const ctx = context({ dino: 1.2 });
    expect(evaluateNeonicCap(ctx, [row('merit', 6, 'fl_oz')]).holds).toEqual([]);
    expect(evaluateNeonicCap(ctx, [row('merit', 7, 'fl_oz')]).blockMessage).toBe('Merit: 7.0 fl oz is over the 6.4 fl oz left this year for this property.');
  });

  test('no bed area: the line says so and nothing holds', () => {
    const ctx = {
      available: true,
      bedSqft: null,
      ingredients: [{ key: 'dinotefuran', usedShare: null, capByProduct: [{ ...ZYLAM_CAP, yearlyAmount: null, remainingAmount: null }], unsized: 0, reason: 'bed_area_needed' }],
    };
    const out = evaluateNeonicCap(ctx, [row('zylam', 99, 'fl_oz')]);
    expect(out.lines.zylam).toBe('Zylam: bed area needed to check the yearly limit.');
    expect(out.holds).toEqual([]);
  });

  test('earlier applications that could not be sized are named', () => {
    expect(evaluateNeonicCap(context({ unsized: 2 }), [row('zylam', '', 'fl_oz')]).lines.zylam).toBe('Zylam left this year: 19.7 fl oz of 19.7 (2 earlier applications not counted)');
    expect(evaluateNeonicCap(context({ unsized: 1 }), [row('zylam', '', 'fl_oz')]).lines.zylam).toContain('(1 earlier application not counted)');
  });
});

describe('Codex r5 #6204: the count limit and products with no limit on file', () => {
  const withZylam = (applicationsUsed, dino = 0.1) => ({
    available: true,
    ingredients: [{
      key: 'dinotefuran', usedShare: dino, unsized: 0, reason: null, uncapped: [{ productId: 'alpine', name: 'Alpine WSG' }],
      capByProduct: [{ ...ZYLAM_CAP, maxApplications: 3, applicationsUsed }, { ...SAFARI_CAP, maxApplications: null, applicationsUsed: null }],
    }],
  });

  test('a fourth Zylam application holds Complete, however small the amount', () => {
    const out = evaluateNeonicCap(withZylam(3), [row('zylam', 0.2, 'fl_oz')]);
    expect(out.holds).toEqual(['Zylam: 3 applications already made this year. The label allows 3.']);
    expect(evaluateNeonicCap(withZylam(3), [row('zylam', '', 'fl_oz')]).blockMessage).toBe('Zylam: 3 applications already made this year. The label allows 3.');
  });

  test('a third application does not hold; an inactive row does not hold; Safari has no count limit', () => {
    expect(evaluateNeonicCap(withZylam(2), [row('zylam', 0.2, 'fl_oz')]).holds).toEqual([]);
    expect(evaluateNeonicCap(withZylam(3), [row('zylam', 0.2, 'fl_oz', false)]).holds).toEqual([]);
    expect(evaluateNeonicCap(withZylam(3), [row('safari', 0.2, 'oz')]).holds).toEqual([]);
  });

  test('a product with no limit on file holds an active row and says why', () => {
    const out = evaluateNeonicCap(withZylam(0), [row('alpine', 1, 'oz')]);
    expect(out.lines).toEqual({ alpine: 'Alpine WSG: no yearly limit on file.' });
    expect(out.blockMessage).toBe('Alpine WSG has no yearly limit on file, so it cannot be checked. Remove it or call the office.');
    expect(evaluateNeonicCap(withZylam(0), [row('alpine', 1, 'oz', false)]).holds).toEqual([]);
    // No bed area on file: the product still cannot be checked, so it still holds.
    const noArea = withZylam(0); noArea.ingredients[0].reason = 'bed_area_needed';
    expect(evaluateNeonicCap(noArea, [row('alpine', 1, 'oz')]).holds).toHaveLength(1);
  });
});
