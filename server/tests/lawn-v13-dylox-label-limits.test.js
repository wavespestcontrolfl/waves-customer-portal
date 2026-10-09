// Lawn protocol v13: the Dylox 6.2 G limits as they end up (migrations 20261009172000 then 20261009173000, label EPA Reg. No. 432-1308):
// at most 2 applications per lawn per calendar year (a Waves rule; the label allows 3), 7 days apart, and 9.07 lb of product per
// 1,000 sq ft a year (the root feeder amount: grubs, mole crickets, chinch bugs). The surface feeders (sod webworm, armyworm, cutworm)
// have a lower label amount and are not part of this program. The recipe states it in every grass track, word for word. No database.
const v13 = require('../config/lawn-protocol-v13.json');
const first = require('../models/migrations/20261009172000_lawn_v13_dylox_label_limits');
const second = require('../models/migrations/20261009173000_lawn_v13_dylox_two_a_year');

const LINE = "Dylox 6.2 G: spreader visits only, water in. For grubs, mole crickets and chinch bugs only, 3 lb per 1,000 sq ft. At most 2 applications per lawn per calendar year, at least 7 days apart (Waves rule; the label allows 3). Not for sod webworms, armyworms or cutworms under this program: the label's yearly amount for those surface feeders is lower (261 lb of product per acre).";
const dyloxLines = (track) => v13[track].safety_rules.filter((line) => line.startsWith('Dylox 6.2 G:'));
const CATALOG_RATE_LB = 3; // migration 20261005130000: Dylox 6.2 G default_rate_per_1000

describe('the recipe: the Dylox 6.2 G limits', () => {
  test.each(Object.keys(v13))('%s: one safety rule line states the limits', (track) => {
    expect(dyloxLines(track)).toEqual([LINE]);
  });

  test('the first migration is frozen at 3 a year; the second takes the count to 2 and keeps the interval and amount rows', () => {
    expect(first.LIMITS.map((l) => [l.limit_type, l.limit_value, l.severity])).toEqual([['annual_max_apps', 3, 'hard_block'], ['min_interval_days', 7, 'hard_block'], ['annual_max_rate', 9.07, 'hard_block']]);
    expect(first.GATE_KEYS).toEqual({ annualMaxApps: 3, minIntervalDays: 7 });
    expect(second.LIMIT).toMatchObject({ limit_type: 'annual_max_apps', limit_value: 2, limit_unit: 'applications', severity: 'hard_block' });
    expect(second.LIMIT.description).not.toBe(first.LIMITS[0].description);
  });

  test('the arithmetic: 2 applications at 3 lb is 261 lb of product per acre, under the root feeder limit of 395 lb per acre (9.07 lb per 1,000 sq ft); 3 at 3 lb is 9 lb, also under it', () => {
    const ACRE = 43.56; // thousands of sq ft
    const perAcre = (passes) => passes * CATALOG_RATE_LB * ACRE;
    const rootFeederPerAcre = 24.5 / 0.062; // 24.5 lb active ingredient at 6.2%, 395 lb of product
    expect(perAcre(second.LIMIT.limit_value)).toBeCloseTo(261.36, 2);
    expect(perAcre(second.LIMIT.limit_value)).toBeLessThan(rootFeederPerAcre);
    expect(rootFeederPerAcre).toBeCloseTo(395, 0);
    expect(first.LIMITS[2].limit_value).toBeLessThanOrEqual(rootFeederPerAcre / ACRE);
    expect(3 * CATALOG_RATE_LB).toBeLessThanOrEqual(first.LIMITS[2].limit_value);
  });

  test('the recipe names Dylox 6.2 G only for grubs, mole crickets and chinch bugs, and rules out the surface feeders', () => {
    for (const track of Object.keys(v13)) {
      const text = JSON.stringify(v13[track]);
      const withDylox = text.split(/\.\s|\\n/).filter((part) => part.includes('Dylox'));
      for (const part of withDylox) expect(part).not.toMatch(/webworm|armyworm|cutworm/i);
      expect(dyloxLines(track)[0]).toMatch(/Not for sod webworms, armyworms or cutworms/);
    }
  });
});
