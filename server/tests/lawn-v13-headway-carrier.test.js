// Lawn protocol v13, the Headway take-all pass in 5 gal of water per 1,000 sq ft (owner 2026-11-20, *headway*; migration
// 20261120140000). The Headway liquid label (EPA Reg. No. 100-1216) allows at most 0.615 fl oz per gallon of water from handheld
// equipment. Pinned without a database: the recipe text on every track, the migration's target, and the tank dose the job card
// shows at the row's carrier. The database half is lawn-v13-headway-carrier.db.test.js.
jest.mock('../models/db', () => {
  const fn = () => ({});
  fn.raw = () => ({});
  fn.schema = { hasTable: async () => true };
  return fn;
});

const v13 = require('../config/lawn-protocol-v13.json');
const migration = require('../models/migrations/20261120140000_lawn_v13_headway_carrier_5gal');
const { buildMixAmount } = require('../services/job-card');

const LABEL_MAX_FL_OZ_PER_GAL = 0.615;
const lines = (text) => String(text || '').split('\n').filter(Boolean);
const headwayLines = (track) => v13[track].visits.flatMap((visit) => [...lines(visit.primary), ...lines(visit.secondary)]
  .filter((line) => line.split(' — ')[0] === migration.HEADWAY)
  .map((line) => ({ month: visit.month, line })));
const doseAt = (ratePer1000, carrierGalPer1000) => buildMixAmount({ ratePer1000, rateUnit: 'fl oz', carrierGalPer1000, gallons: 1 });

describe('the Headway take-all pass: 3 fl oz in 5 gal of water per 1,000 sq ft', () => {
  test.each(Object.keys(v13))('the %s recipe puts the Headway pass in 5 gal of water in April and October', (track) => {
    const found = headwayLines(track);
    expect(found.map(({ month }) => month)).toEqual(['Apr', 'Oct']);
    for (const { line } of found) expect(line).toContain('3 fl oz per 1,000 sq ft in 5 gal of water, 30 days after the first application');
  });

  test('the migration gives the rows of the two take-all windows 5 gal; its audit actions fit varchar(40)', () => {
    expect(migration.WINDOWS).toEqual(['apr_v13_spreader_feeding', 'oct_v13_spreader_fall']);
    expect(migration.CARRIER_GAL_PER_1000).toBe(5);
    for (const action of [migration.ACTION, migration.NOTE_ACTION]) expect(action.length).toBeLessThanOrEqual(40);
  });

  test('the job card doses 0.6 fl oz a gallon at 5 gal, under the label limit; at the old 2 gal even the lowest label rate is over it', () => {
    expect(doseAt(3, migration.CARRIER_GAL_PER_1000)).toMatchObject({ amount: 0.6, unit: 'fl oz', coversSqft: 200 });
    expect(doseAt(3, migration.CARRIER_GAL_PER_1000).amount).toBeLessThanOrEqual(LABEL_MAX_FL_OZ_PER_GAL);
    expect(doseAt(3, 2).amount).toBe(1.5);
    expect(doseAt(1.5, 2).amount).toBeGreaterThan(LABEL_MAX_FL_OZ_PER_GAL);
  });
});
