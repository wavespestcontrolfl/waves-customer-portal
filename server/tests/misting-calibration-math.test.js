// Spray-rate math for the misting install calibration (GATE_MOSQUITO_MISTING). Pure functions, checked against
// shared/misting-calibration-cases.json, the same file the client preview math is tested against.
const { computeCalibration, overLabelMessage, formatOzPair, roundTo } = require('../services/misting-calibration-math');
const { cases } = require('../../shared/misting-calibration-cases.json');
const { products } = require('../../shared/misting-products.json');

const productFor = (key) => (key ? products.find((p) => p.key === key) : null);

describe('shared/misting-products.json', () => {
  test('Sector carries the label numbers: 9.5 fl oz limit, 64 to 128 fl oz in 55 gal', () => {
    const sector = products.find((p) => p.key === 'sector');
    expect(sector).toMatchObject({
      name: 'Sector Misting Concentrate',
      epaRegNo: '1021-1834',
      labelMaxFlOzPer1000CuFtPerDay: 9.5,
      labelRateMix: { concentrateFlOz: 64, waterGal: 55 },
      maxMix: { concentrateFlOz: 128, waterGal: 55 },
    });
    expect(sector.source).toMatch(/9\.5 fl\. oz\./);
  });
});

describe('computeCalibration', () => {
  test('there are at least 6 worked cases, including an over-label case and a boundary case', () => {
    expect(cases.length).toBeGreaterThanOrEqual(6);
    expect(cases.some((c) => c.expected.withinLabel === false)).toBe(true);
    expect(cases.some((c) => c.expected.dailyOutputFlOz === c.expected.labelDailyCapFlOz)).toBe(true);
  });

  test.each(cases.map((c) => [c.name, c]))('%s', (_name, c) => {
    expect(computeCalibration(c.input, productFor(c.input.productKey))).toEqual(c.expected);
  });

  test('a stronger mix of a known product lowers the cap; an unknown product ignores the mix', () => {
    const base = cases[0].input;
    const sector = productFor('sector');
    expect(computeCalibration({ ...base, concentrateFlOzPerTank: 128 }, sector).labelDailyCapFlOz).toBe(228);
    expect(computeCalibration({ ...base, concentrateFlOzPerTank: 128 }, null).labelDailyCapFlOz).toBe(456);
  });
});

describe('roundTo', () => {
  test('rounds half up and drops float noise', () => {
    expect(roundTo(1.005, 2)).toBe(1.01); // 1.005 is 1.00499999999999989 in binary
    expect(roundTo(1.0049, 2)).toBe(1);
    expect(roundTo(9258.75, 1)).toBe(9258.8);
    expect(roundTo(2.675, 2)).toBe(2.68);
  });
});

describe('overLabelMessage', () => {
  test('names both numbers to one decimal', () => {
    expect(overLabelMessage(61.875, 47.5)).toBe('This schedule puts out 61.9 fl oz a day. The label allows 47.5. Shorten the mist or run fewer cycles.');
  });
  test('shows three decimals when one decimal would print the pair the same', () => {
    expect(formatOzPair(47.519, 47.5)).toEqual(['47.519', '47.5']);
  });
});
