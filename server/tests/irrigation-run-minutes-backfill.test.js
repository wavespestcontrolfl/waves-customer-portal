/**
 * 20260825000002 — promote unambiguous per-zone runtimes out of legacy
 * schedule notes into irrigation_run_minutes (GH codex P1 on #3478).
 * The parser copies only what the customer literally stated, once, in
 * bounds — everything uncertain stays NULL for the email ask to collect.
 */
const { __private, up } = require('../models/migrations/20260825000002_irrigation_run_minutes_backfill');

const { parseRunMinutesFromNotes, noteDaysConsistent } = __private;

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
    // Qualified, negated, or disabled statements are not uniform active
    // runtimes (GH codex P1 on #3478 r9).
    ['Not every zone runs 20 min', 'negated'],
    ['Each zone runs 20 min except zone 3', 'exception'],
    ['Each zone runs 20 min, but it is disabled', 'disabled'],
    ['System off for the winter, each zone runs 20 min', 'seasonal off'],
    ['Each zone used to run 20 min', 'past tense'],
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
    // The allowlist guard: ANY word outside the benign schedule vocabulary
    // declines — repetition phrased a way no blocklist anticipated (GH codex
    // P1 on #3478 r10), or unrelated remarks we cannot vouch for.
    ['Each zone runs 20 minutes, pauses, then goes again.', 'unanticipated repetition'],
    ['Each zone runs 20 min, controller in garage', 'off-vocabulary remark'],
    ['Each zone runs 20 min when it feels like it', 'off-vocabulary remark'],
    // Bare clock values are all digits and slip the word allowlist — the
    // number budget catches them (GH codex P1 on #3478 r11).
    ['Each zone runs 20 min at 4 and 6am', 'abbreviated double start time'],
    ['Each zone runs 20 min at 4am and 6', 'abbreviated double start time'],
    // "per start" is one cycle's duration, not the daily total (GH codex
    // P1 r19) — start/starts are outside the allowlist entirely.
    ['20 min per zone per start', 'per-start duration'],
    ['Each zone runs 20 min, starts at 4am', 'start vocabulary'],
    // A weekly total is not per-watering-day minutes (GH codex P1 r15).
    ['20 min per zone per week', 'weekly total, wrong unit'],
    ['Each zone runs 20 min weekly', 'weekly total, wrong unit'],
    // Bounds: the column validates 1–240.
    ['Each zone runs 500 min', 'out of bounds'],
    ['Each zone runs 0 min', 'out of bounds'],
    ['', 'empty'],
    [null, 'null'],
  ])('declines %j (%s)', (notes) => {
    expect(parseRunMinutesFromNotes(notes)).toBeNull();
  });
});

describe('noteDaysConsistent', () => {
  // A note asserting its own days must agree with the structured
  // watering_days the derivation multiplies by (GH codex P1 #3478 r17).
  test('day claims must match the structured days exactly', () => {
    expect(noteDaysConsistent('Each zone runs 20 min on Tuesday and Thursday', ['Tue', 'Thu'])).toBe(true);
    expect(noteDaysConsistent('Each zone runs 20 min on Tuesday and Thursday', ['Mon', 'Wed', 'Fri'])).toBe(false);
    expect(noteDaysConsistent('Each zone runs 20 min on Tue', ['Tue', 'Thu'])).toBe(false);
    expect(noteDaysConsistent('Each zone runs 20 min on Tuesday', null)).toBe(false);
    // A daily-cadence phrase claims all seven days (GH codex P1 #3478 r18).
    expect(noteDaysConsistent('Every zone runs 20 minutes every day', ['Mon', 'Wed', 'Fri'])).toBe(false);
    expect(noteDaysConsistent('Every zone runs 20 minutes every day', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])).toBe(true);
    expect(noteDaysConsistent('Each zone runs 20 min, all days', ['Mon', 'Wed'])).toBe(false);
    // "per day"/"a day" are the same seven-day claim (GH codex P1 r20).
    expect(noteDaysConsistent('20 min per zone per day', ['Mon', 'Wed', 'Fri'])).toBe(false);
    expect(noteDaysConsistent('Each zone runs 20 min a day', ['Mon', 'Wed', 'Fri'])).toBe(false);
    expect(noteDaysConsistent('20 min per zone per day', ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])).toBe(true);
    // JSONB-as-string rows and no-claim notes both behave.
    expect(noteDaysConsistent('Each zone runs 20 min Mon/Wed', '["Mon","Wed"]')).toBe(true);
    expect(noteDaysConsistent('Each zone runs 20 min', ['Mon', 'Wed', 'Fri'])).toBe(true);
  });
});

describe('up()', () => {
  test('no-ops when the table or columns are absent', async () => {
    const knex = () => { throw new Error('must not query'); };
    knex.schema = { hasTable: async () => false, hasColumn: async () => false };
    await expect(up(knex)).resolves.toBeUndefined();
  });
});
