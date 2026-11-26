// A night move of a plan's FIRST visit (the parent row) must not shift the plan (owner 2026-11-26: the night run may move
// a first visit). The night writers stamp no date exception on a plan visit (a nudge is placement, not intent), but on
// the parent row they do: its cadence position is the plan's round anchor when none is stored and the base a top-up
// projects from when it is the latest live visit. No database.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { dateExceptionStamp } = require('../services/rebooker');
const { seriesCadencePosition, seriesRoundAnchor } = require('../services/recurring-appointment-seeder');
const { seriesExtendAnchor } = require('../routes/admin-schedule')._test;

const PARENT = {
  id: 'p1', is_recurring: true, recurring_parent_id: null, recurring_pattern: 'quarterly',
  scheduled_date: '2027-01-12', date_exception: false, date_exception_cadence_date: null,
};
const CHILD = { ...PARENT, id: 'c1', recurring_parent_id: 'p1', scheduled_date: '2027-04-13' };
// The row as the rebooker writes it: the stamp from the row it read, then the new date.
const moved = (row, toDate, source) => ({ ...row, ...dateExceptionStamp(row, source), scheduled_date: toDate });

describe('night writers stamp a parent-row day move only', () => {
  test.each(['auto_dispatch', 'day_replan'])('%s: the parent keeps its cadence date; a plan visit gets no stamp', (source) => {
    expect(dateExceptionStamp(PARENT, source)).toMatchObject({ date_exception: true, date_exception_source: source, date_exception_cadence_date: '2027-01-12' });
    expect(dateExceptionStamp(CHILD, source)).toEqual({});
  });

  test('a second night move keeps the FIRST cadence date', () => {
    const once = moved(PARENT, '2027-01-14', 'auto_dispatch');
    expect(dateExceptionStamp(once, 'auto_dispatch').date_exception_cadence_date).toBe('2027-01-12');
  });

  test('a one-time visit (not recurring) is never stamped', () => {
    expect(dateExceptionStamp({ ...PARENT, is_recurring: false }, 'auto_dispatch')).toEqual({});
  });
});

describe('the plan reads the same dates after the parent moved', () => {
  const after = moved(PARENT, '2027-01-15', 'auto_dispatch');

  test('cadence position and round anchor stay on the date the parent left', () => {
    expect(seriesCadencePosition(after)).toBe(seriesCadencePosition(PARENT));
    expect(seriesRoundAnchor(after)).toBe(seriesRoundAnchor(PARENT));
    expect(seriesRoundAnchor(after)).toBe('2027-01-12');
  });

  test('a top-up projecting from the moved parent lands on the same next date', () => {
    expect(seriesExtendAnchor(after, 'quarterly', {})).toBe(seriesExtendAnchor(PARENT, 'quarterly', {}));
  });

  test('without the stamp the anchor WOULD shift (what this guards against)', () => {
    const unstamped = { ...PARENT, scheduled_date: '2027-01-15' };
    expect(seriesRoundAnchor(unstamped)).toBe('2027-01-15');
  });
});

describe('flex-tier series keys (owner 2026-11-26)', () => {
  const flexTier = require('../services/auto-dispatch/flex-tier');
  test('a plan visit keys on its parent, a first visit on itself, a one-time visit and a booster on nothing', () => {
    expect(flexTier.seriesKeyOf({ id: 'c1', is_recurring: true, recurring_parent_id: 'p1' })).toBe('p1');
    expect(flexTier.seriesKeyOf({ id: 'p1', is_recurring: true, recurring_parent_id: null })).toBe('p1');
    expect(flexTier.seriesKeyOf({ id: 'o1', is_recurring: false, recurring_parent_id: null })).toBeNull();
    expect(flexTier.isOneTimeVisit({ id: 'o1', is_recurring: null, recurring_parent_id: null })).toBe(true);
    expect(flexTier.isOneTimeVisit({ id: 'b1', is_recurring: false, recurring_parent_id: 'p1' })).toBe(false);
  });

  test('a one-time visit has no neighbors and the ±5 band, with no read', async () => {
    const db = jest.fn(() => { throw new Error('must not query'); });
    const map = await flexTier.loadSeriesNeighbors(db, [{ id: 'o1', is_recurring: false, recurring_parent_id: null }], { withRadius: true });
    expect(map.get('o1')).toEqual({ prev: null, next: null, radiusDays: 5, nearestDays: null });
  });
});

describe('the office "customer asked for this time" box marks the first visit only (owner 2026-11-26)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-schedule.js'), 'utf8');
  test('only the first row of a new booking copies the box', () => {
    expect(src.match(/Object\.assign\(\w+, askedTimeStamp\(cols, customerAskedTime\)\)/g)).toEqual(['Object.assign(insertData, askedTimeStamp(cols, customerAskedTime))']);
  });
});

describe('the customer reschedule page records "asked for this time" for a Waves Assessment only (owner 2026-11-26)', () => {
  const { dayPromiseMoveIntent } = require('../routes/reschedule-public')._internals;
  test('an assessment keeps the asked time; any other visit records nothing', async () => {
    await expect(dayPromiseMoveIntent({ id: 'v1', service_type: 'Waves Assessment' })).resolves.toEqual({ customerAskedTime: true });
    await expect(dayPromiseMoveIntent({ id: 'v2', service_type: 'General Pest Control', service_id: null })).resolves.toEqual({});
    await expect(dayPromiseMoveIntent(null)).resolves.toEqual({});
  });
});
