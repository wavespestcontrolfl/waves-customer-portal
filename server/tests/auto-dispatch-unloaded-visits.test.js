// Visits the night run never loads (a one-time visit, a plan's first visit, a booster-month visit, a locked or
// excluded visit) are still read for a conflict at the run's end, so one on a closed day or on top of another stop
// raises the needs-a-person notice (owner 2026-11-26: "all visits should be checked ... an office can move them").
// The run never moves them. No database.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/auto-dispatch/needs-person-notice', () => ({
  ...jest.requireActual('../services/auto-dispatch/needs-person-notice'),
  farListedVisitIds: jest.fn(async () => []),
  standingVisitIds: jest.fn(async () => []),
}));

const db = require('../models/db');
const { _internals: { conflictsToSettle, unloadedLiveVisitIds } } = require('../services/auto-dispatch');
const notice = require('../services/auto-dispatch/needs-person-notice');

function scanDb(rows, { fail = false } = {}) {
  const calls = [];
  const fn = jest.fn((table) => {
    const c = { table, wheres: [] };
    ['leftJoin', 'whereNull', 'whereIn', 'whereNotNull', 'limit'].forEach((m) => { c[m] = (...a) => { c.wheres.push([m, ...a]); return c; }; });
    c.where = (...a) => { c.wheres.push(['where', ...a]); return c; };
    c.select = () => c;
    c.then = (res, rej) => (fail ? Promise.reject(new Error('boom')) : Promise.resolve(rows)).then(res, rej);
    calls.push(c);
    return c;
  });
  fn.calls = calls;
  return fn;
}

const RUN = (extra = {}) => ({
  config: { conflictMovesEnabled: true }, conflicts: new Map(), loaded: [{ id: 'loaded1' }], strandedIds: [],
  today: '2026-12-01', lookaheadEnd: '2026-12-31', ...extra,
});

beforeEach(() => jest.clearAllMocks());

test('open timed visits in the window that pass 1 did not load are read for a conflict, as notice-raising entries', async () => {
  db.mockImplementation(scanDb([{ id: 'loaded1' }, { id: 'oneTime1' }, { id: 'locked1' }]));
  const pending = await conflictsToSettle(RUN());
  expect(pending.get('oneTime1')).toMatchObject({ reason: 'NOT_AUTO_DISPATCHED' });
  expect(pending.get('oneTime1').noticeOnly).toBeUndefined();
  expect(pending.get('locked1')).toMatchObject({ reason: 'NOT_AUTO_DISPATCHED' });
  expect(pending.get('loaded1')).toMatchObject({ reason: 'SKIPPED' });
  const q = db.mock.results[0].value;
  expect(q.wheres).toEqual(expect.arrayContaining([
    ['whereNotNull', 'scheduled_services.window_start'],
    ['where', 'scheduled_services.scheduled_date', '>', '2026-12-01'],
    ['where', 'scheduled_services.scheduled_date', '<=', '2026-12-31'],
  ]));
});

test('a failed read marks the scan incomplete and adds nothing; conflict reads off: no read', async () => {
  db.mockImplementation(scanDb([], { fail: true }));
  expect(await unloadedLiveVisitIds(RUN())).toBeNull();
  const run = RUN();
  run.conflictScanComplete = true;
  const pending = await conflictsToSettle(run);
  expect(run.conflictScanComplete).toBe(false);
  expect([...pending.keys()]).toEqual(['loaded1']);
  db.mockClear();
  await conflictsToSettle(RUN({ config: { conflictMovesEnabled: false } }));
  expect(db).not.toHaveBeenCalled();
});

test('the notice says auto-dispatch does not move it, so a person must', () => {
  const bucket = new Map();
  notice.collectUnmoved(bucket, { id: 'v1', scheduled_date: '2026-12-03' }, 'NOT_AUTO_DISPATCHED', { kind: 'closed_day', date: '2026-12-03' });
  const item = [...bucket.values()][0];
  expect(item).toMatchObject({ kind: 'not_auto', problem: 'closed_day' });
});
