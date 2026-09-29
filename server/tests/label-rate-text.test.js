// A catalog label rate as the tech assistant and the knowledge base give it
// (owner ruling: nothing a tech reads is in mL). The catalog keeps the
// label's own mL figure; a tech reads truck measures, rounded inward so the
// amount never leaves the label range.

const { convertInventoryQuantity } = require('../services/inventory-units');
const { techLabelRate, techLabelRateText } = require('../services/label-rate-text');

const FRACTIONS = { '': 0, '⅛': 0.125, '¼': 0.25, '⅜': 0.375, '½': 0.5, '⅝': 0.625, '¾': 0.75, '⅞': 0.875 };

// "1¼–2" tsp -> [low, high] in mL, through the same conversion the module uses.
function readBackMl(rate, unit) {
  const amounts = rate.split('–').map((text) => {
    const match = /^(\d*)([⅛¼⅜½⅝¾⅞]?)$/.exec(text);
    if (!match || text === '') throw new Error(`not a spoon or cup step: "${rate}"`);
    return Number(match[1] || 0) + FRACTIONS[match[2]];
  });
  const flOz = unit.startsWith('tsp') ? amounts.map((tsp) => tsp / 6) : amounts;
  const [low, high = low] = flOz.map((oz) => convertInventoryQuantity(oz, 'fl_oz', 'ml'));
  return [low, high];
}

describe('techLabelRate — an mL label rate reads in tsp or fl oz', () => {
  test.each([
    // [catalog rate, catalog unit, rate, unit]
    ['5-10', 'ml/gal', '1¼–2', 'tsp/gal'],
    ['1.25-5', 'ml/gal', '½–1', 'tsp/gal'],
    ['1-6', 'ml/inch dbh', '¼–1', 'tsp/inch dbh'],
    ['5 to 10', 'ml/gal', '1¼–2', 'tsp/gal'],
    ['5–10', 'ml/gal', '1¼–2', 'tsp/gal'],
    // Once the top of the range reaches 1 fl oz, the ounce cup.
    ['5-30', 'ml/palm', '¼–1', 'fl oz/palm'],
    // A single amount rounds down; ⅛ tsp only when no ¼ fits.
    ['30', 'ml', '1', 'fl oz'],
    ['1', 'ml/gal', '⅛', 'tsp/gal'],
  ])('%s %s → %s %s', (rate, unit, expectedRate, expectedUnit) => {
    expect(techLabelRate(rate, unit)).toEqual({ rate: expectedRate, unit: expectedUnit });
  });

  test('the low end rounds up and the high end down, so the amount stays on the label', () => {
    // 1.25 mL is 0.25 tsp and a hair: ¼ tsp would be under the label minimum.
    expect(techLabelRate('1.25-5', 'ml/gal').rate).toBe('½–1');
  });

  test('every converted rate reads back inside the label figure', () => {
    // A range stays between its ends; a single amount is never exceeded.
    const figures = [0.5, 0.6, 1, 1.01, 1.03, 1.25, 2, 2.5, 3, 5, 7.5, 10, 15, 20, 29, 29.6, 30, 30.5, 45, 60, 90, 118];
    let converted = 0;
    for (const low of figures) {
      for (const high of figures.filter((n) => n >= low)) {
        const figure = low === high ? `${low}` : `${low}-${high}`;
        const { rate, unit } = techLabelRate(figure, 'ml/gal');
        if (rate == null) continue;
        converted += 1;
        const [readLow, readHigh] = readBackMl(rate, unit);
        const floor = low === high ? 0 : low - 1e-6;
        expect({ figure, inside: readLow > 0 && readLow >= floor && readHigh <= high + 1e-6 })
          .toEqual({ figure, inside: true });
        expect(`${rate} ${unit}`).not.toMatch(/\bml\b/i);
      }
    }
    expect(converted).toBeGreaterThan(200);
  });

  test('a figure no spoon or cup step fits inside has no rate — the assistant sends the tech to the label', () => {
    // 1.01–1.03 mL is 0.205–0.209 tsp: no ⅛ step lies inside it.
    expect(techLabelRate('1.01-1.03', 'ml/gal')).toEqual({ rate: null, unit: null });
    expect(techLabelRate('1-1.1', 'ml/gal')).toEqual({ rate: null, unit: null });
    // Under ⅛ tsp.
    expect(techLabelRate('0.5', 'ml/gal')).toEqual({ rate: null, unit: null });
  });

  test('an mL figure that cannot be read comes back empty, never in mL', () => {
    expect(techLabelRate('see label', 'ml/gal')).toEqual({ rate: null, unit: null });
    expect(techLabelRate('1-2-3', 'ml/gal')).toEqual({ rate: null, unit: null });
    expect(techLabelRate('0', 'ml/gal')).toEqual({ rate: null, unit: null });
    expect(techLabelRate(null, 'ml/gal')).toEqual({ rate: null, unit: null });
  });

  test('every other unit reads exactly as the catalog states it', () => {
    expect(techLabelRate('0.2-0.8', 'fl_oz/gal')).toEqual({ rate: '0.2-0.8', unit: 'fl_oz/gal' });
    expect(techLabelRate('2.87', 'lb/1000 sq ft')).toEqual({ rate: '2.87', unit: 'lb/1000 sq ft' });
    expect(techLabelRate('5', null)).toEqual({ rate: '5', unit: null });
  });
});

describe('techLabelRateText — the knowledge base "Default Rate" line', () => {
  test('an mL label reads in tsp', () => {
    expect(techLabelRateText('5-10', 'ml/gal')).toBe('1¼–2 tsp/gal');
  });

  test('any other rate reads byte-for-byte as it always did', () => {
    expect(techLabelRateText('0.2-0.8', 'fl_oz/gal')).toBe('0.2-0.8 fl_oz/gal');
    expect(techLabelRateText('5', null)).toBe('5 ');
  });

  test('an mL figure with no rate to state leaves no line rather than an mL one', () => {
    expect(techLabelRateText('see label', 'ml/gal')).toBe('');
    expect(techLabelRateText('1.01-1.03', 'ml/gal')).toBe('');
  });

  test('no rate leaves no line, as before', () => {
    expect(techLabelRateText(null, 'oz/1000 sq ft')).toBe('');
    expect(techLabelRateText('', 'ml/gal')).toBe('');
  });
});
