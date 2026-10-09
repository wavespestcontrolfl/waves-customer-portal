// Lawn protocol v13: the Dylox 6.2 G label limit (3 applications to turf per calendar year, 7 days apart; EPA Reg. No. 432-1308)
// is in the safety rules of every grass track, word for word. No database.
const v13 = require('../config/lawn-protocol-v13.json');
const migration = require('../models/migrations/20261009172000_lawn_v13_dylox_label_limits');

const LINE = 'Dylox 6.2 G: spreader visits only, water in. At most 3 applications per lawn per calendar year, at least 7 days apart, and no more than 9 lb per 1,000 sq ft a year (label). For chinch bugs or sod webworms: at most 2 applications a year (label: 6 lb per 1,000 sq ft a year for surface feeders).';
const dyloxLines = (track) => v13[track].safety_rules.filter((line) => line.startsWith('Dylox 6.2 G:'));

describe('the recipe: the Dylox 6.2 G label limit', () => {
  test.each(Object.keys(v13))('%s: one safety rule line states the limit', (track) => {
    expect(dyloxLines(track)).toEqual([LINE]);
  });

  test('the migration writes the numbers the line states', () => {
    expect(migration.LIMITS.map((l) => [l.limit_type, l.limit_value, l.severity])).toEqual([['annual_max_apps', 3, 'hard_block'], ['min_interval_days', 7, 'hard_block'], ['annual_max_rate', 9.07, 'hard_block']]);
    // 24.5 lb ai per acre at 6.2% = 395.2 lb product per acre = 9.0715 lb per 1,000 sq ft: the row sits at or under the label.
    expect(migration.LIMITS[2].limit_value).toBeLessThanOrEqual((24.5 / 0.062) / 43.56);
    expect(migration.GATE_KEYS).toEqual({ annualMaxApps: 3, minIntervalDays: 7 });
  });
});
