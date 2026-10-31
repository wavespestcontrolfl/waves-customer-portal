// The size rule for moves (owner 2026-10-31): on a lawn_rounds_9 series a date move of 7 days or fewer,
// inside one round, moves only that visit. Pure date math; the paths that apply it are tested beside them.
const fs = require('fs');
const path = require('path');
const {
  LAWN_ROUNDS_9, roundOf, roundsMoveIsOneOff, roundsOneOffWindow, roundsRowMoveIsOneOff, roundsRegularDate, datesMoveSeries,
} = require('../services/lawn-rounds');

describe('roundsMoveIsOneOff', () => {
  // Round 8 of program year 2026 runs 2026-10-01 to 2026-11-09.
  test.each([
    ['2026-10-15', '2026-10-16', true],
    ['2026-10-15', '2026-10-22', true],   // +7, the limit
    ['2026-10-15', '2026-10-08', true],   // -7
    ['2026-10-15', '2026-10-23', false],  // +8
    ['2026-10-15', '2026-10-07', false],  // -8
    ['2026-10-15', '2026-10-15', true],   // same date
    ['2026-10-05', '2026-09-30', false],  // 5 days, but round 7 ends 2026-09-30
    ['2026-11-07', '2026-11-10', false],  // 3 days, but round 9 starts 2026-11-10
    ['2026-10-01', '2026-10-08', true],   // first day of the round
    ['2026-11-09', '2026-11-03', true],   // last day of the round
    ['2026-12-23', '2026-12-26', false],  // across the program-year boundary (round 9 ends 12-24)
    ['2026-12-20', '2026-12-24', true],
  ])('%s -> %s is a one-off: %s', (from, to, expected) => {
    expect(roundsMoveIsOneOff(LAWN_ROUNDS_9, from, to)).toBe(expected);
  });

  test('only lawn_rounds_9 qualifies', () => {
    for (const pattern of ['custom', 'every_6_weeks', 'weekly', 'monthly', 'quarterly', 'seasonal_feb_oct', null, undefined, '']) {
      expect(roundsMoveIsOneOff(pattern, '2026-10-15', '2026-10-16')).toBe(false);
    }
  });

  test('unreadable dates are never a one-off', () => {
    for (const [from, to] of [[null, '2026-10-16'], ['2026-10-15', null], ['nope', '2026-10-16'], ['2026-10-15', '2026-13-40'], [undefined, undefined]]) {
      expect(roundsMoveIsOneOff(LAWN_ROUNDS_9, from, to)).toBe(false);
    }
  });

  test('maxDays is a parameter; the window never leaves the round', () => {
    expect(roundsMoveIsOneOff(LAWN_ROUNDS_9, '2026-10-15', '2026-10-18', { maxDays: 3 })).toBe(true);
    expect(roundsMoveIsOneOff(LAWN_ROUNDS_9, '2026-10-15', '2026-10-19', { maxDays: 3 })).toBe(false);
    expect(roundsOneOffWindow(LAWN_ROUNDS_9, '2026-10-03')).toEqual({
      maxDays: 7, fromDate: '2026-10-03', roundStart: '2026-10-01', roundEnd: '2026-11-09', start: '2026-10-01', end: '2026-10-10',
    });
    expect(roundOf('2026-10-03').start).toBe('2026-10-01');
    expect(roundsOneOffWindow('custom', '2026-10-03')).toBeNull();
  });

  test('accepts a Date or a timestamp string for either argument', () => {
    expect(roundsMoveIsOneOff(LAWN_ROUNDS_9, '2026-10-15T00:00:00.000Z', '2026-10-16T09:00:00')).toBe(true);
    expect(roundsMoveIsOneOff(LAWN_ROUNDS_9, new Date('2026-10-15T12:00:00Z'), new Date('2026-10-30T12:00:00Z'))).toBe(false);
  });
});

describe('roundsRowMoveIsOneOff measures from the regular date', () => {
  const row = (extra = {}) => ({ recurring_pattern: LAWN_ROUNDS_9, scheduled_date: '2026-10-21', ...extra });

  test('a row with no date exception measures from its own date', () => {
    expect(roundsRegularDate(row())).toBe('2026-10-21');
    expect(roundsRowMoveIsOneOff(row(), '2026-10-28')).toBe(true);
    expect(roundsRowMoveIsOneOff(row(), '2026-10-29')).toBe(false);
  });

  test('a date exception measures from the cadence date it deviated from', () => {
    const moved = row({ date_exception: true, date_exception_cadence_date: '2026-10-15' });
    expect(roundsRegularDate(moved)).toBe('2026-10-15');
    expect(roundsRowMoveIsOneOff(moved, '2026-10-22')).toBe(true);
    expect(roundsRowMoveIsOneOff(moved, '2026-10-23')).toBe(false); // 2 days from where it sits, 8 from the regular date
  });

  test('an exception flag with no cadence date, or a cadence date with no flag, falls back to the row date', () => {
    expect(roundsRegularDate(row({ date_exception: true, date_exception_cadence_date: null }))).toBe('2026-10-21');
    expect(roundsRegularDate(row({ date_exception: false, date_exception_cadence_date: '2026-10-15' }))).toBe('2026-10-21');
  });

  test('keeping the row on its own date is no move, so never a one-off', () => {
    expect(roundsRowMoveIsOneOff(row(), '2026-10-21')).toBe(false);
    expect(roundsRowMoveIsOneOff(row(), new Date('2026-10-21T00:00:00Z'))).toBe(false);
  });

  test('a row of another pattern, and a missing row, are never a one-off', () => {
    expect(roundsRowMoveIsOneOff(row({ recurring_pattern: 'custom' }), '2026-10-22')).toBe(false);
    expect(roundsRowMoveIsOneOff(null, '2026-10-22')).toBe(false);
    expect(roundsRowMoveIsOneOff({}, '2026-10-22')).toBe(false);
  });
});

describe('the SMS offer executor shares the page decision', () => {
  test('sms-scheduling-act commits through the same shouldReanchor the page uses, and loadById reads the cadence columns', () => {
    const router = require('../routes/reschedule-public');
    expect(router._internals.shouldReanchor).toBe(router._test.shouldReanchor);
    expect(fs.readFileSync(path.join(__dirname, '../services/sms-scheduling-act.js'), 'utf8')).toContain('page.shouldReanchor(svc, slot.date)');
    const page = fs.readFileSync(path.join(__dirname, '../routes/reschedule-public.js'), 'utf8');
    expect(page).toMatch(/'s\.date_exception',\s*\n\s*'s\.date_exception_cadence_date',/);
  });
});

describe('datesMoveSeries: a date change that shifts the series (rebooker preview, rain-out, call reschedule)', () => {
  const row = (extra = {}) => ({ recurring_pattern: LAWN_ROUNDS_9, scheduled_date: '2026-10-21', ...extra });

  test('no target, or the same date, is no series move', () => {
    expect(datesMoveSeries(row(), '2026-10-21', null)).toBe(false);
    expect(datesMoveSeries(row(), '2026-10-21', '2026-10-21')).toBe(false);
  });

  test('a lawn rounds one-off is no series move; a bigger move is', () => {
    expect(datesMoveSeries(row(), '2026-10-21', '2026-10-28')).toBe(false);
    expect(datesMoveSeries(row(), '2026-10-21', '2026-10-29')).toBe(true);
  });

  test('every other pattern: any date change is a series move', () => {
    expect(datesMoveSeries(row({ recurring_pattern: 'custom' }), '2026-10-21', '2026-10-22')).toBe(true);
  });
});

describe('every staff and tool surface asks the one shared decision (rebooker.movesAsSeries)', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const COLUMNS = "'recurring_pattern', 'date_exception', 'date_exception_cadence_date'";

  test.each([
    ['routes/admin-schedule.js', ['movesAsSeries(svc, bulkTargetDate)', 'movesAsSeries(row, target)', 'movesAsSeries(moveRow, collectiveMoveTarget)',
      // the direct writers confirm the decision on the row they hold; the Edit series commit passes its scope
      "singleMoveStamp(svc, bulkTargetDate, 'admin_bulk')", "singleMoveStamp(preTupleRow, updates.scheduled_date, 'admin')", "expectScope: 'series'"], 6],
    ['services/intelligence-bar/tools.js', ['movesAsSeries(appt, dateStr) && dateStr !== oldDateStr', "singleMoveStamp(appt, dateStr, 'admin_ib')"], 2],
    ['services/intelligence-bar/schedule-tools.js', ["require('../rebooker').movesAsSeries(s, dateStr)", "singleMoveStamp(s, dateStr, 'admin_ib')"], 2],
    ['routes/admin-intelligence-bar.js', ["require('../services/rebooker').movesAsSeries(pin, params.new_date)"], 1],
  ])('%s', (rel, needles) => {
    const src = read(rel);
    for (const needle of needles) expect(src).toContain(needle);
    // No surface keeps its own copy of the old gate-plus-flag test for a date move.
    expect(src).not.toMatch(/collectiveMoveGateOn\(\) && (svc|appt|row|moveRow)\.is_recurring === true/);
  });

  test('the narrow selects carry the pattern and the cadence columns, so a short rounds move is judged on its row', () => {
    const schedule = read('routes/admin-schedule.js');
    expect(schedule.match(new RegExp(COLUMNS.replace(/[()]/g, '\\$&'), 'g')).length).toBeGreaterThanOrEqual(2);
    expect(read('routes/admin-intelligence-bar.js')).toContain("'ss.recurring_pattern', 'ss.date_exception', 'ss.date_exception_cadence_date'");
  });

  test('the choke point and the dispatch preview use the shared decision or its preview verdict', () => {
    const rebooker = read('services/rebooker.js');
    expect(rebooker.match(/movesAsSeries\(service, newDate\)/g)).toHaveLength(3); // the scope check, the grouped replay, the series branch
    const dispatch = read('routes/admin-dispatch.js');
    expect(dispatch).toContain('preview.oneOff !== true');
    expect(dispatch).toContain('if (preview?.oneOff) {');
  });
});
