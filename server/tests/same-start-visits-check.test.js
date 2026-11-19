// Same-start visits check (owner 2026-11-19, "build check"): one customer's two
// visits on one upcoming day at the same start ring one Schedule bell for that
// customer. These tests pin the bell the office reads (who, when, which visit,
// every day), the rules it must pass (docs/admin-notifications.md), when a
// standing bell rings again, and a failed read. The SQL itself runs on Postgres
// in same-start-visits-check-postgres.test.js. All fixtures are synthetic.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { SAME_START_PREFIX, sameStartVisitAlerts, _timeWords } = require('../services/same-start-visits-check');
const { MAX_HEADLINE_CHARS, MAX_WHY_CHARS } = require('../services/admin-alert-compose');

const TODAY = '2026-11-19';
// What pg returns for a DATE column on Railway and in CI: UTC midnight.
const day = (iso) => new Date(`${iso}T00:00:00Z`);
const visit = (over = {}) => ({
  id: 'visit-a', customer_id: 'cust-1', scheduled_date: day('2026-12-03'), window_start: '11:00:00',
  service_type: 'Lawn Care Service', first_name: 'Pat', last_name: 'Example', ...over,
});
// The finder's rows (a thenable knex chain), or a failed read.
function finderReturns(rows, error = null) {
  const chain = {};
  for (const m of ['join', 'whereIn', 'where', 'whereNull', 'distinct', 'orderBy']) chain[m] = jest.fn(() => chain);
  chain.then = (res, rej) => (error ? Promise.reject(error) : Promise.resolve(rows)).then(res, rej);
  db.mockImplementation(() => chain);
}

beforeEach(() => jest.clearAllMocks());

test('two visits at one start make one bell: who, when, the visit to move, the day in the detail', async () => {
  finderReturns([visit({ id: 'visit-b', service_type: 'Pest Control Service' }), visit()]);
  const { alerts, failed } = await sameStartVisitAlerts(TODAY);
  expect(db).toHaveBeenCalledWith('scheduled_services as a');
  expect(failed).toBe(false);
  expect(alerts).toHaveLength(1);
  const [key, title, body, metadata, opts] = alerts[0];
  expect(key).toBe(`${SAME_START_PREFIX}cust-1`);
  expect(title).toBe("Schedule — split Pat Example's visits at the same time");
  expect(body).toBe('2 visits start at 11 AM on Dec 3; split them so they run back to back, one hour each.');
  // Services in name order; the link opens that day on the last of them.
  expect(opts.link).toBe('/admin/dispatch?tab=schedule&date=2026-12-03&appointment=visit-b');
  expect(opts.detail).toBe('Dec 3 at 11 AM: Lawn Care Service and Pest Control Service.');
  expect(opts.refreshOnDedupe).toBe(true);
  expect(metadata).toEqual({
    customer_id: 'cust-1', first_date: '2026-12-03', day_count: 1, day_keys: ['2026-12-03 11:00'], visit_ids: ['visit-a', 'visit-b'],
    area: 'Schedule', severity: 'needs-you', subject: { type: 'customer', id: 'cust-1' }, doneWhen: 'visits_start_apart', who: 'person',
  });
});

test('many days: the why counts them from the first, later-year days carry the year, and past ten the detail counts the rest', async () => {
  const dates = ['2026-12-07', '2027-02-08', '2027-04-05', '2027-06-07', '2027-08-02', '2027-10-04',
    '2027-12-06', '2028-02-07', '2028-04-03', '2028-06-05', '2028-08-07', '2028-10-02'];
  finderReturns(dates.flatMap((date, i) => [
    visit({ id: `lawn-${i}`, scheduled_date: day(date), window_start: '10:30:00' }),
    visit({ id: `shrub-${i}`, scheduled_date: day(date), window_start: '10:30:00', service_type: 'Tree & Shrub Care Service' }),
  ]));
  const [[, title, body, metadata, opts]] = (await sameStartVisitAlerts(TODAY)).alerts;
  expect(body).toBe('12 days have visits at the same time, first Dec 7 at 10:30 AM; split each so they run back to back.');
  expect(opts.detail).toMatch(/^Dec 7 at 10:30 AM: Lawn Care Service and Tree & Shrub Care Service\. Feb 8, 2027 at 10:30 AM: /);
  expect(opts.detail).toMatch(/ Jun 5, 2028 at 10:30 AM: Lawn Care Service and Tree & Shrub Care Service\. And 2 more days\.$/);
  expect(opts.link).toBe('/admin/dispatch?tab=schedule&date=2026-12-07&appointment=shrub-0');
  expect(metadata).toMatchObject({ first_date: '2026-12-07', day_count: 12 });
  expect(metadata.day_keys).toHaveLength(12);
  expect(metadata.ruleViolations).toBeUndefined();
  expect(title.length).toBeLessThanOrEqual(MAX_HEADLINE_CHARS);
});

test('the longest why still fits the 110-character rule: a later-year first day at a half hour', async () => {
  const dates = Array.from({ length: 24 }, (_, i) => `2027-${10 + Math.floor(i / 8)}-${i % 8 + 10}`);
  dates[0] = '2027-09-30';
  finderReturns(dates.flatMap((date, i) => [
    visit({ id: `a-${i}`, scheduled_date: day(date), window_start: '10:30:00' }),
    visit({ id: `b-${i}`, scheduled_date: day(date), window_start: '10:30:00', service_type: 'Pest Control Service' }),
  ]));
  const [[, , body, metadata]] = (await sameStartVisitAlerts(TODAY)).alerts;
  expect(body).toBe('24 days have visits at the same time, first Sep 30, 2027 at 10:30 AM; split each so they run back to back.');
  expect(body.length).toBeLessThanOrEqual(MAX_WHY_CHARS);
  expect(metadata.ruleViolations).toBeUndefined();
});

test('three visits at one start, and two customers: one bell each, every visit named', async () => {
  finderReturns([
    visit({ id: 'v1', window_start: '09:00:00' }),
    visit({ id: 'v2', window_start: '09:00:00', service_type: 'Mosquito Service' }),
    visit({ id: 'v3', window_start: '09:00:00', service_type: 'Pest Control Service' }),
    visit({ id: 'w1', customer_id: 'cust-2', first_name: 'Sam', last_name: 'Sample', scheduled_date: day('2027-01-12'), window_start: '12:00:00' }),
    visit({ id: 'w2', customer_id: 'cust-2', first_name: 'Sam', last_name: 'Sample', scheduled_date: day('2027-01-12'), window_start: '12:00:00', service_type: 'Pest Control Service' }),
  ]);
  const { alerts } = await sameStartVisitAlerts(TODAY);
  expect(alerts.map((a) => a[0])).toEqual([`${SAME_START_PREFIX}cust-1`, `${SAME_START_PREFIX}cust-2`]);
  expect(alerts[0][2]).toBe('3 visits start at 9 AM on Dec 3; split them so they run back to back, one hour each.');
  expect(alerts[0][4].detail).toBe('Dec 3 at 9 AM: Lawn Care Service, Mosquito Service and Pest Control Service.');
  expect(alerts[1][2]).toBe('2 visits start at 12 PM on Jan 12, 2027; split them so they run back to back, one hour each.');
});

test('a long name is cut to the 60-character headline; a name the rules refuse still rings in plain words', async () => {
  finderReturns([visit({ first_name: 'Maximiliana Josephine', last_name: 'Bartholomew-Vanderbilt' }), visit({ id: 'visit-b' })]);
  const [[, longTitle, , longMeta]] = (await sameStartVisitAlerts(TODAY)).alerts;
  expect(longTitle.length).toBeLessThanOrEqual(MAX_HEADLINE_CHARS);
  expect(longTitle).toMatch(/^Schedule — split Maximiliana .*(visits at the same time|same-time visits)$/);
  expect(longMeta.ruleViolations).toBeUndefined();

  finderReturns([visit({ first_name: '[Test]' }), visit({ id: 'visit-b', first_name: '[Test]' })]);
  const [[key, title, body, metadata]] = (await sameStartVisitAlerts(TODAY)).alerts;
  expect(key).toBe(`${SAME_START_PREFIX}cust-1`);
  expect(title).toBe('Two visits start at the same time for [Test] Example');
  expect(body).toBe('2 visits start at 11 AM on Dec 3; split them so they run back to back, one hour each.');
  expect(metadata.ruleViolations).toEqual(expect.arrayContaining(['headline_forbidden_token:bracket_tag']));
  expect(metadata).toMatchObject({ subject: { type: 'customer', id: 'cust-1' }, doneWhen: 'visits_start_apart', who: 'person' });
});

test('a standing bell rings again only when a day it did not list joins; a fixed day updates it quietly', async () => {
  finderReturns([visit(), visit({ id: 'visit-b' })]);
  const [[, , , , { ringOnRefresh }]] = (await sameStartVisitAlerts(TODAY)).alerts;
  expect(ringOnRefresh({}, { day_keys: ['2026-12-03 11:00'] })).toBe(false);
  expect(ringOnRefresh({}, { day_keys: ['2026-12-03 11:00', '2027-01-05 09:00'] })).toBe(false);
  expect(ringOnRefresh({}, { day_keys: ['2027-01-05 09:00'] })).toBe(true);
  expect(ringOnRefresh({}, {})).toBe(true);
});

test('a failed read is reported, not swallowed into "no pairs": the watchdog then keeps the standing bells', async () => {
  finderReturns([], new Error('connection reset'));
  expect(await sameStartVisitAlerts(TODAY)).toEqual({ alerts: [], failed: true });
  expect(logger.error).toHaveBeenCalledWith('[schedule-integrity] same-start visit check failed: connection reset');
});

test('times read the way a person says them', () => {
  expect(['09:00', '12:00', '00:30', '13:05', '16:00'].map(_timeWords)).toEqual(['9 AM', '12 PM', '12:30 AM', '1:05 PM', '4 PM']);
});
