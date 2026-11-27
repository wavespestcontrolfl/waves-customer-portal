// The LESCO spreader number for a granular line (spreader-settings.js, config/spreader-settings.json): the product's row nearest
// the line's rate, only within 3% of it; a field-tested row says so, a start number asks for a weigh test. Pure, no database.
const { spreaderSetting, spreaderForLine, lineLbRate, lineLbPer1000, settingText, config, NO_RATE_NUMBER, NO_PRODUCT_NUMBER } = require('../services/spreader-settings');
const protocol = require('../config/lawn-protocol-v13.json');

describe('the spreader number for a rate', () => {
  test('the field-tested 10-0-22 at 4.5 lb is #12 (field tested)', () => {
    expect(spreaderSetting({ names: ['LESCO 10-0-22 50% PolyPlus OPTI45 50% YaraRega Turfgrass Granular Fertilizer'], lbPer1000: 4.5 }))
      .toMatchObject({ spreader: 'LESCO rotary', setting: 12, basis: 'tested', text: 'Spreader: LESCO #12 (field tested)' });
  });
  test('a start number reads 9½ and asks for a weigh test; the nearest row for the product wins', () => {
    const name = ['LESCO 24-0-11 with PolyPlus OPTI'];
    expect(spreaderSetting({ names: name, lbPer1000: 3.125 })).toMatchObject({ setting: 9.5, basis: 'start', text: 'Spreader: LESCO #9½, start number. Weigh test at first use.' });
    expect(spreaderSetting({ names: name, lbPer1000: 4.1667 })).toMatchObject({ setting: 11, rowLbPer1000: 4.17 });
  });
  test('3% rule: a rate within 3% of a row takes its number; one further off, or no rate, gets none and a weigh test', () => {
    const name = ['LESCO 44-0-0 100% PolyPlus OPTI120'];
    expect(spreaderSetting({ names: name, lbPer1000: 2.27 * 1.029 }).setting).toBe(8);
    expect(spreaderSetting({ names: name, lbPer1000: 2.27 * 0.971 }).setting).toBe(8);
    // Both exact 3% boundaries count (float rounding: 2.06 / 2 is 0.030000000000000027 off).
    expect(spreaderSetting({ names: ['Topchoice Granular Insecticide'], lbPer1000: 2.06 }).setting).toBe(8);
    expect(spreaderSetting({ names: ['Topchoice Granular Insecticide'], lbPer1000: 1.94 }).setting).toBe(8);
    expect(spreaderSetting({ names: ['Topchoice Granular Insecticide'], lbPer1000: 2.07 }).setting).toBeNull();
    for (const lbPer1000 of [2.27 * 1.04, 1.135, null]) {
      expect(spreaderSetting({ names: name, lbPer1000 })).toMatchObject({ setting: null, text: NO_RATE_NUMBER });
    }
  });
  test('a granular product with no row says so', () => {
    expect(spreaderSetting({ names: ['Synthetic granule'], lbPer1000: 2 })).toMatchObject({ setting: null, text: NO_PRODUCT_NUMBER });
  });
  test('the liquid Stonewall and the liquid Dimension never match the granular rows', () => {
    expect(spreaderSetting({ names: ['LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide'], lbPer1000: 4.04 }).setting).toBeNull();
    expect(spreaderSetting({ names: ['Dimension 2EW'], lbPer1000: 2.78 }).setting).toBeNull();
  });
  test('settingText and the line rate', () => {
    expect([settingText(9.5), settingText(11), settingText(16)]).toEqual(['9½', '11', '16']);
    expect(lineLbPer1000('LESCO 24-0-11 with PolyPlus OPTI — 3.1 lb per 1,000 sq ft (0.75 lb N), spreader')).toBe(3.1);
    expect(lineLbPer1000('Bag — 2 to 3 lb per 1,000 sq ft')).toBeNull();
  });
  test('the 13-0-13 bed line reads its bed rate (0.75 lb per 100 sq ft = 7.5 per 1,000), not its nitrogen cap: #16', () => {
    const protocols = JSON.stringify(require('../config/protocols.json'));
    const raw = /13-0-13 ornamental fertilizer \(LESCO 13-0-13[^"\\]*/.exec(protocols)[0];
    expect(raw).toMatch(/caps nitrogen at 1 lb per 1,000 sq ft/);
    expect(lineLbRate(raw)).toEqual({ rate: 7.5 });
    expect(spreaderForLine({ productName: 'LESCO 13-0-13 60% PolyPlus Landscape', raw })).toMatchObject({ setting: 16, text: 'Spreader: LESCO #16, start number. Weigh test at first use.' });
  });
  test('a ranged line states no one rate in any spelling, so it gets no number without a plan rate', () => {
    for (const raw of ['Topchoice — 1 to 2 lb per 1,000 sq ft', 'Topchoice — 1-2 lb per 1,000 sq ft', 'Topchoice — 1\u20132 lb per 1,000 sq ft']) {
      expect(lineLbRate(raw)).toEqual({ range: true });
      expect(spreaderForLine({ productName: 'Topchoice Granular Insecticide', raw })).toMatchObject({ setting: null, text: NO_RATE_NUMBER });
    }
    expect(lineLbRate('Topchoice — 2 lb per 1,000 sq ft')).toEqual({ rate: 2 });
  });
  test('an approved swap matches only the bag applied, at the rate passed: never the recipe bag\'s name or rate', () => {
    const raw = 'LESCO 10-0-22 50% PolyPlus OPTI45 Turfgrass Granular Fertilizer — 4.5 lb per 1,000 sq ft, spreader';
    expect(spreaderForLine({ productName: 'Synthetic swap bag', raw, rate: 4.5, rateUnit: 'lb', substituted: true })).toMatchObject({ setting: null, text: NO_PRODUCT_NUMBER });
    expect(spreaderForLine({ productName: 'LESCO 44-0-0 100% PolyPlus OPTI120', raw, substituted: true })).toMatchObject({ setting: null, text: NO_RATE_NUMBER });
    expect(spreaderForLine({ productName: 'LESCO 44-0-0 100% PolyPlus OPTI120', raw, rate: 2.27, rateUnit: 'lb', substituted: true }).setting).toBe(8);
  });
});

describe('the spreader field for one line', () => {
  test('the plan rate in lb wins; else the line\'s own lb rate', () => {
    const raw = 'LESCO 24-0-11 with PolyPlus OPTI — 3.1 lb per 1,000 sq ft (0.75 lb N), spreader';
    expect(spreaderForLine({ productName: 'LESCO 24-0-11 with PolyPlus OPTI', raw, rate: 4.17, rateUnit: 'lb' }).setting).toBe(11);
    expect(spreaderForLine({ productName: 'LESCO 24-0-11 with PolyPlus OPTI', raw, rate: 0.75, rateUnit: 'lb_n' }).setting).toBe(9.5);
  });
  test('a hand-shaker bait and a product on the no-number list get no spreader field', () => {
    expect(spreaderForLine({ productName: 'Synthetic bait', raw: 'Synthetic bait — 3 lb per 1,000 sq ft by hand shaker', rate: 3, rateUnit: 'lb' })).toBeNull();
    expect(spreaderForLine({ productName: 'Advion Insect Granule', raw: 'Advion Insect Granule — 3 lb per 1,000 sq ft', rate: 3, rateUnit: 'lb' })).toBeNull();
  });
});

// Every granular line the v13 program prints (each track's visits and their round and trouble variants) either gets a number at
// the rate it puts down, or its product is on the config's no-number list with a reason. A new granular line cannot ship
// without one. A line that states no rate takes its catalog rate (the 20261005130000 catalog row) from CATALOG_LB below.
const CATALOG_LB = { 'Dylox 6.2 G Granular Insecticide': 3 };
const GRANULAR = /\bspreader\b|hand\s*shaker|\bgranul|\blbs?\s+per\s+1,?000/i;
function programLines(node, out = []) {
  if (Array.isArray(node)) node.forEach((child) => programLines(child, out));
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'primary' || key === 'secondary') && typeof value === 'string') out.push(...value.split('\n').map((line) => line.trim()).filter(Boolean));
      else programLines(value, out);
    }
  }
  return out;
}

describe('every granular line in lawn-protocol-v13.json', () => {
  const lines = [...new Set(programLines(protocol))].filter((line) => line.includes(' — ') && GRANULAR.test(line.split(' — ').slice(1).join(' — ')))
    // A sprayed line that names lb of N only (a liquid) is not granular: its own rate is in fl oz.
    .filter((line) => !/fl\.?\s*oz\s+per\s+1,?000/i.test(line));
  test('the program has granular lines to check', () => {
    expect(lines.length).toBeGreaterThanOrEqual(8);
  });
  test.each(lines.map((line) => [line.slice(0, 70), line]))('%s', (_, line) => {
    const name = line.split(' — ')[0];
    const listed = config.noNumber.find((entry) => name.toLowerCase().includes(entry.productMatch.toLowerCase()));
    if (listed || /hand\s*shaker/i.test(line)) {
      expect((listed?.reason || 'hand shaker').length).toBeGreaterThan(5);
      return;
    }
    const rate = lineLbPer1000(line) ?? CATALOG_LB[name];
    const found = spreaderForLine({ productName: name, raw: line, rate, rateUnit: 'lb' });
    expect(found).toMatchObject({ setting: expect.any(Number) });
  });
});
