// Lawn protocol v13: the Dylox 6.2 G limits as they end up (migrations 20261009172000 then 20261009173000, label EPA Reg. No. 432-1308):
// at most 2 applications per lawn per calendar year (a Waves rule; the label allows 3 for grubs and mole crickets), 7 days apart,
// and 9.07 lb of product per 1,000 sq ft a year. The recipe states it in every grass track, word for word. No database.
const v13 = require('../config/lawn-protocol-v13.json');
const first = require('../models/migrations/20261009172000_lawn_v13_dylox_label_limits');
const second = require('../models/migrations/20261009173000_lawn_v13_dylox_two_a_year');

const LINE = 'Dylox 6.2 G: spreader visits only, water in. At most 2 applications per lawn per calendar year, at least 7 days apart (Waves rule; the label allows 3 for grubs and mole crickets, and 6 lb per 1,000 sq ft a year for chinch bugs and sod webworms).';
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

  test('the numbers agree with the label: 2 passes at the catalog rate fit 16.2 lb ai per acre and a third would not; the amount row is under 24.5 lb ai per acre', () => {
    const aiPerAcre = (passes) => passes * CATALOG_RATE_LB * 43.56 * 0.062;
    expect(aiPerAcre(second.LIMIT.limit_value)).toBeCloseTo(16.2, 1);
    expect(aiPerAcre(second.LIMIT.limit_value + 1)).toBeGreaterThan(16.2);
    expect(first.LIMITS[2].limit_value * 43.56 * 0.062).toBeLessThanOrEqual(24.5);
  });
});
