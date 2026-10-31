// Misting calibration preview math (GATE_MOSQUITO_MISTING). Checked against the same worked cases file the
// server math is tested against, so the two copies cannot drift.
import { describe, expect, it } from 'vitest';
import { computeCalibration, formatOzPair, overLabelMessage, previewLine, roundTo } from './mistingCalibrationMath';
import CASES from '../../../shared/misting-calibration-cases.json';
import PRODUCT_FILE from '../../../shared/misting-products.json';

const productFor = (key) => (key ? PRODUCT_FILE.products.find((p) => p.key === key) : null);

describe('computeCalibration', () => {
  it('has at least 6 worked cases, including an over-label case and a boundary case', () => {
    expect(CASES.cases.length).toBeGreaterThanOrEqual(6);
    expect(CASES.cases.some((c) => c.expected.withinLabel === false)).toBe(true);
    expect(CASES.cases.some((c) => c.expected.dailyOutputFlOz === c.expected.labelDailyCapFlOz)).toBe(true);
  });

  it.each(CASES.cases.map((c) => [c.name, c]))('%s', (_name, c) => {
    expect(computeCalibration(c.input, productFor(c.input.productKey))).toEqual(c.expected);
  });
});

describe('roundTo', () => {
  it('rounds half up and drops float noise', () => {
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(9258.75, 1)).toBe(9258.8);
  });
});

describe('messages', () => {
  it('words the over-label sentence the way the server does', () => {
    expect(overLabelMessage(61.875, 47.5)).toBe('This schedule puts out 61.9 fl oz a day. The label allows 47.5. Shorten the mist or run fewer cycles.');
  });

  it('shows three decimals when one decimal would print the pair the same', () => {
    expect(formatOzPair(47.519, 47.5)).toEqual(['47.519', '47.5']);
  });

  it('previewLine says the limit used, and flags a stronger mix', () => {
    const base = CASES.cases[0];
    const ok = computeCalibration(base.input, productFor('sector'));
    expect(previewLine(ok)).toBe('Puts out 99 fl oz a day. The label allows 456 at this mix.');
    const strong = CASES.cases[1];
    expect(previewLine(computeCalibration(strong.input, productFor('sector')))).toBe(
      'Puts out 99 fl oz a day. The label allows 228 at this mix. Stronger mix: the daily limit is lower.',
    );
    const over = CASES.cases.find((c) => !c.expected.withinLabel);
    expect(previewLine(computeCalibration(over.input, productFor(over.input.productKey)))).toMatch(/^This schedule puts out 61\.9 fl oz a day\./);
  });
});
