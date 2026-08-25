/**
 * 20260825000002 — promote unambiguous per-zone runtimes out of legacy
 * schedule notes into irrigation_run_minutes (GH codex P1 on #3478).
 * The parser copies only what the customer literally stated, once, in
 * bounds — everything uncertain stays NULL for the email ask to collect.
 */
const { __private, up } = require('../models/migrations/20260825000002_irrigation_run_minutes_backfill');

const { parseRunMinutesFromNotes } = __private;

describe('parseRunMinutesFromNotes', () => {
  test.each([
    ['Each zone runs 20min', 20],
    ['each zone runs 20 minutes', 20],
    ['Every zone gets about 25 minutes', 25],
    ['All zones run 15 min', 15],
    ['20 min per zone', 20],
    ['20 minutes/zone', 20],
    ['45 mins each zone', 45],
    ['Zones run 30 minutes, Mon/Wed/Fri at 4am', 30],
    ['Runs Mon Wed Fri, each zone runs 20min, rain sensor on', 20],
  ])('promotes %j → %d', (notes, expected) => {
    expect(parseRunMinutesFromNotes(notes)).toBe(expected);
  });

  test.each([
    // No per-zone runtime statement at all.
    ['Runs Mon/Wed/Fri at 4am', 'no minutes stated'],
    ['3 zones, rain sensor', 'no minutes stated'],
    // Two distinct figures — per-zone schedules a single column cannot hold.
    ['Front zones run 20 min, back zone runs 45 min', 'ambiguous'],
    ['Each zone runs 20min, zone 3 seems to run 40 minutes', 'ambiguous'],
    // A bare number with no zone phrasing is not a per-zone runtime.
    ['Waters for 20 minutes', 'not per-zone'],
    // A duration in another unit is a conflicting figure the minutes scan
    // cannot see (GH codex P1 on #3478 r5).
    ['Each zone runs 20 min except zone 3 runs 1 hour', 'hour conflict'],
    ['Each zone runs 20min, back yard half an hour', 'hour conflict'],
    // Multiple daily runs multiply weekly volume beyond minutes × days.
    ['Each zone runs 20min twice a day', 'multiple daily runs'],
    ['20 min per zone, 2x daily', 'multiple daily runs'],
    ['Each zone runs 15 minutes 3 times per day', 'multiple daily runs'],
    ['Each zone runs 20 min twice each watering day', 'multiple daily runs'],
    ['20 min per zone, two cycles', 'multiple daily runs'],
    ['Each zone runs 20min, runs again in the evening', 'multiple daily runs'],
    ['Each zone runs 20 min, second run at 6pm', 'multiple daily runs'],
    // Two mentions of the SAME value are two cycles, not agreement.
    ['Each zone runs 20 min at 4am and 20 min at 6pm', 'equal-duration double run'],
    // Multiple time-of-day mentions are multiple runs however phrased.
    ['Each zone runs 20 min at 4am and 6pm', 'two clock times'],
    ['Each zone runs 20 min morning and evening', 'paired day-parts'],
    ['Each zone runs 20 min AM & PM', 'am-pm pair'],
    // Bounds: the column validates 1–240.
    ['Each zone runs 500 min', 'out of bounds'],
    ['Each zone runs 0 min', 'out of bounds'],
    ['', 'empty'],
    [null, 'null'],
  ])('declines %j (%s)', (notes) => {
    expect(parseRunMinutesFromNotes(notes)).toBeNull();
  });
});

describe('up()', () => {
  test('no-ops when the table or columns are absent', async () => {
    const knex = () => { throw new Error('must not query'); };
    knex.schema = { hasTable: async () => false, hasColumn: async () => false };
    await expect(up(knex)).resolves.toBeUndefined();
  });
});
