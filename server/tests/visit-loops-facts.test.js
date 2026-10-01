/**
 * visit-loops-facts: the read-only "visit status and open loops" facts
 * (tech position, late alert, passed window, missed visit, live note, promises
 * we owe, asks still waiting). Mocked db; no network. Synthetic data only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/call-commitments', () => ({ listOpenCommitments: jest.fn() }));
jest.mock('../services/sms-operational-actions', () => ({ smsCommitmentsEnabled: jest.fn(), listSmsCommitments: jest.fn() }));
// the customer tracker's own stop count (read-only) is the only source of a number
jest.mock('../services/stops-ahead', () => ({ computeStopsAhead: jest.fn(async () => ({ stopsAhead: 2, yourStop: 3, totalStops: 6 })) }));
const { computeStopsAhead } = require('../services/stops-ahead');

const logger = require('../services/logger');
const featureGates = require('../config/feature-gates');
const { listOpenCommitments } = require('../services/call-commitments');
const { smsCommitmentsEnabled, listSmsCommitments } = require('../services/sms-operational-actions');
const { loadVisitLoops, emptyVisitLoops, familyKey } = require('../services/visit-loops-facts');

// 2026-10-01 12:00 ET (EDT, UTC-4).
const NOW = new Date('2026-10-01T16:00:00Z');
const minutesAgo = (n) => new Date(NOW.getTime() - n * 60000);

// A chainable fake knex: every builder method records itself and returns the
// chain; `first` / awaiting resolves whatever handlers[table] returns for the
// recorded ops.
function fakeConn(handlers) {
  const calls = [];
  const conn = (tableSpec) => {
    const table = String(tableSpec).split(/\s+as\s+/i)[0];
    const ops = [];
    const chain = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (res, rej) => {
            calls.push({ table, ops, terminal: 'all' });
            return Promise.resolve().then(() => handlers[table]?.(ops, 'all')).then(res, rej);
          };
        }
        if (prop === 'first') {
          return (...args) => {
            ops.push({ op: 'first', args });
            calls.push({ table, ops, terminal: 'first' });
            return Promise.resolve().then(() => handlers[table]?.(ops, 'first'));
          };
        }
        return (...args) => { ops.push({ op: prop, args }); return chain; };
      },
    });
    return chain;
  };
  conn.calls = calls;
  conn.raw = (sql) => ({ raw: sql });
  return conn;
}
const hasOp = (ops, op, pred) => ops.some((o) => o.op === op && (!pred || pred(o.args)));
const isUnfinishedQuery = (ops) => hasOp(ops, 'where', (a) => a[0] === 'scheduled_date' && a[1] === '<');

const todayEntry = (over = {}) => ({ type: 'Pest Control', date: '2026-10-01', isToday: true, tech: 'Jamie Rivera', scheduledServiceId: 'visit-1', ...over });
const todayRow = (over = {}) => ({
  id: 'visit-1', technician_id: 'tech-1', route_order: 3, scheduled_date: '2026-10-01', status: 'confirmed', track_state: null,
  window_start: '09:00:00', window_end: '10:00:00', window_display: null, time_window: null, service_type: 'Pest Control',
  technician_name: 'Jamie Rivera', ...over,
});
const deriveWindow = (row) => (row.window_start === '09:00:00' ? '9:00 AM–11:00 AM' : null);

beforeEach(() => {
  jest.clearAllMocks();
  featureGates.gates.callCommitments = false;
  delete process.env.GATE_EMAIL_OPERATIONAL_ACTIONS;
  smsCommitmentsEnabled.mockReturnValue(false);
  listOpenCommitments.mockResolvedValue([]);
  listSmsCommitments.mockResolvedValue([]);
});

describe('loadVisitLoops basics', () => {
  test('no customer id yields the all-empty shape and touches nothing', async () => {
    const conn = jest.fn();
    expect(await loadVisitLoops({ customerId: null, conn })).toEqual(emptyVisitLoops());
    expect(conn).not.toHaveBeenCalled();
  });

  test('no today visit and no history: every field empty', async () => {
    const conn = fakeConn({});
    const out = await loadVisitLoops({ customerId: 'c1', upcomingServices: [{ isToday: false, scheduledServiceId: 'x' }], now: NOW, conn });
    expect(out).toEqual(emptyVisitLoops());
  });

  test('strict (send-time rebuild): a failed read throws instead of reading as empty', async () => {
    const conn = () => { throw new Error('db down'); };
    await expect(loadVisitLoops({ customerId: 'c1', now: NOW, conn, strict: true })).rejects.toThrow('db down');
  });

  test('the signature changes on a reassignment or a same-day window move, not on display labels', () => {
    const { visitStatusSignature } = require('../services/visit-loops-facts');
    const tp = { visitId: 'v1', techId: 't1', windowStart: '09:00:00', status: 'en_route', atThisVisit: false, stopsAhead: 2, windowDisplay: '9–11' };
    const base = visitStatusSignature({ techPosition: tp });
    expect(visitStatusSignature({ techPosition: { ...tp, techId: 't2' } })).not.toBe(base);
    expect(visitStatusSignature({ techPosition: { ...tp, windowStart: '13:00:00' } })).not.toBe(base);
    expect(visitStatusSignature({ techPosition: { ...tp, windowDisplay: '9:00 AM–11:00 AM' } })).toBe(base);
    // a staff correction of the service the line names
    expect(visitStatusSignature({ techPosition: { ...tp, visitType: 'Lawn Care' } })).not.toBe(visitStatusSignature({ techPosition: { ...tp, visitType: 'Pest Control' } }));
    expect(visitStatusSignature({ pastWindow: { visitId: 'v1', windowStart: '09:00:00', type: 'Lawn' } })).not.toBe(visitStatusSignature({ pastWindow: { visitId: 'v1', windowStart: '09:00:00', type: 'Pest' } }));
    expect(visitStatusSignature({ pastWindow: { visitId: 'v1', windowStart: '09:00:00' } })).not.toBe(visitStatusSignature({ pastWindow: { visitId: 'v1', windowStart: '10:00:00' } }));
  });

  test('a db that throws on every call never throws out: all fields empty, warnings logged', async () => {
    const conn = () => { throw new Error('db down'); };
    const out = await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, conn });
    expect(out).toEqual(emptyVisitLoops());
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('techPosition', () => {
  const handlers = (extra = {}) => ({
    scheduled_services: (ops, kind) => {
      if (hasOp(ops, 'leftJoin')) return [todayRow(extra.visit)];
      return kind === 'first' ? null : [];
    },
    tech_status: () => ('status' in extra ? extra.status : { status: 'en_route', current_job_id: 'other', location_updated_at: minutesAgo(2) }),
  });

  test('fresh position: status, minutes, the tracker\'s stop count (read-only), first name only', async () => {
    const conn = fakeConn(handlers());
    const out = await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, conn, deriveWindow });
    expect(out.techPosition).toEqual({
      techName: 'Jamie', status: 'en_route', minutesSinceUpdate: 2, stopsAhead: 2, atThisVisit: false,
      visitId: 'visit-1', techId: 'tech-1', windowStart: '09:00:00', visitType: 'Pest Control', windowDisplay: '9:00 AM–11:00 AM',
    });
    expect(computeStopsAhead).toHaveBeenCalledWith(conn, 'visit-1', { readOnly: true, today: '2026-10-01', throwOnError: false });
  });

  test('strict (send-time rebuild) asks the tracker to rethrow, so an outage is a recheck failure', async () => {
    computeStopsAhead.mockRejectedValueOnce(new Error('route read down'));
    await expect(loadVisitLoops({ customerId: 'c1', now: NOW, conn: fakeConn(handlers()), strict: true })).rejects.toThrow('route read down');
    expect(computeStopsAhead).toHaveBeenLastCalledWith(expect.anything(), 'visit-1', expect.objectContaining({ throwOnError: true }));
  });

  test('no tracker count (gate off, over the cap, not yet the durable floor): no number', async () => {
    for (const result of [null, { pending: true }]) {
      computeStopsAhead.mockResolvedValueOnce(result);
      const out = await loadVisitLoops({ customerId: 'c1', now: NOW, conn: fakeConn(handlers()) });
      expect(out.techPosition.stopsAhead).toBeNull();
    }
  });

  test('atThisVisit when the tech status points at this visit', async () => {
    const conn = fakeConn(handlers({ status: { status: 'on_site', current_job_id: 'visit-1', location_updated_at: minutesAgo(1) } }));
    const out = await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, conn });
    expect(out.techPosition).toMatchObject({ status: 'on_site', atThisVisit: true });
  });

  test('en route TO this visit (current_job_id already set) is not "at this visit"', async () => {
    const conn = fakeConn(handlers({ status: { status: 'en_route', current_job_id: 'visit-1', location_updated_at: minutesAgo(1) } }));
    const out = await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, conn });
    expect(out.techPosition).toMatchObject({ status: 'en_route', atThisVisit: false });
  });

  test('yesterday\'s 23:00 visit stays in today\'s facts until its window ends at 01:00 ET', async () => {
    const late = todayRow({ id: 'v-late', scheduled_date: '2026-09-30', window_start: '23:00:00', window_end: '23:45:00' });
    const at = (iso) => loadVisitLoops({ customerId: 'c1', now: new Date(iso), conn: fakeConn({ ...handlers(), scheduled_services: (ops) => (hasOp(ops, 'leftJoin') ? [late] : []) }) });
    expect((await at('2026-10-01T04:30:00Z')).techPosition).toMatchObject({ visitId: 'v-late' }); // 00:30 ET
    expect((await at('2026-10-01T05:30:00Z')).techPosition).toBeNull(); // 01:30 ET: no longer live
  });

  test('a fresh tech_status whose current job is this visit means no stop count, even with a lagging confirmed row', async () => {
    const conn = fakeConn(handlers({ status: { status: 'on_site', current_job_id: 'visit-1', location_updated_at: minutesAgo(1) } }));
    const out = await loadVisitLoops({ customerId: 'c1', now: NOW, conn });
    expect(out.techPosition).toMatchObject({ atThisVisit: true, stopsAhead: null });
  });

  test('a started visit (status or tracker) carries no stop count and never asks the tracker', async () => {
    for (const visit of [{ status: 'en_route' }, { status: 'on_site' }, { status: 'confirmed', track_state: 'on_property' }]) {
      computeStopsAhead.mockClear();
      const out = await loadVisitLoops({ customerId: 'c1', now: NOW, conn: fakeConn(handlers({ visit })) });
      expect(out.techPosition.stopsAhead).toBeNull();
      expect(computeStopsAhead).not.toHaveBeenCalled();
    }
  });

  test('a location older than five minutes reads stale but keeps the age', async () => {
    const conn = fakeConn(handlers({ status: { status: 'en_route', current_job_id: null, location_updated_at: minutesAgo(9) } }));
    const out = await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, conn });
    expect(out.techPosition).toMatchObject({ status: 'stale', minutesSinceUpdate: 9, atThisVisit: false });
  });

  test('a fix slightly in the future (within the tracker\'s tolerance) is fresh, not stale', async () => {
    const conn = fakeConn(handlers({ status: { status: 'en_route', current_job_id: null, location_updated_at: minutesAgo(-0.5) } }));
    const out = await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, conn });
    expect(out.techPosition).toMatchObject({ status: 'en_route', minutesSinceUpdate: 0 });
    const far = fakeConn(handlers({ status: { status: 'en_route', current_job_id: null, location_updated_at: minutesAgo(-10) } }));
    expect((await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, conn: far })).techPosition.status).toBe('stale');
  });

  test('no tech_status row: stale with unknown age', async () => {
    const conn = fakeConn(handlers({ status: null }));
    const out = await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, conn });
    expect(out.techPosition).toMatchObject({ status: 'stale', minutesSinceUpdate: null, atThisVisit: false });
  });

  test('no assigned tech: null', async () => {
    const conn = fakeConn(handlers({ visit: { technician_id: null } }));
    const out = await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, conn });
    expect(out.techPosition).toBeNull();
  });

  test('a failing tech_status read nulls only that field', async () => {
    const h = handlers();
    h.tech_status = () => { throw new Error('boom'); };
    const out = await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, conn: fakeConn(h), deriveWindow });
    expect(out.techPosition).toBeNull();
    expect(out.pastWindow).toMatchObject({ type: 'Pest Control' });
  });
});

describe('lateAlert', () => {
  const run = (alert) => loadVisitLoops({
    customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, deriveWindow,
    conn: fakeConn({
      scheduled_services: (ops, kind) => (hasOp(ops, 'leftJoin') ? [todayRow({ status: 'en_route' })] : (kind === 'first' ? null : [])),
      dispatch_alerts: () => (alert ? [].concat(alert) : []),
    }),
  });

  test('an open alert carries type, severity and minutes from the payload (string or object)', async () => {
    const which = { visitId: 'visit-1', windowStart: '09:00:00', visitType: 'Pest Control', windowDisplay: '9:00 AM–11:00 AM' };
    expect((await run({ type: 'tech_late', severity: 'warn', job_id: 'visit-1', payload: JSON.stringify({ delay_minutes: 35, scheduled_date: '2026-10-01', window_start: '09:00:00' }) })).lateAlert)
      .toEqual({ type: 'tech_late', severity: 'warn', minutesLate: 35, missingTracking: false, ...which });
    expect((await run({ type: 'unassigned_overdue', severity: 'critical', job_id: 'visit-1', payload: { delay_minutes: '12', scheduled_date: '2026-10-01', window_start: '09:00:00' } })).lateAlert)
      .toEqual({ type: 'unassigned_overdue', severity: 'critical', minutesLate: 12, missingTracking: false, ...which });
  });

  test('a no-show-detector missing-tracking alert is a tracking gap, not lateness', async () => {
    const payload = { source: 'no_show_detector', evidence: 'missing_tracking', stage: 1, delay_minutes: 50, promised_window: { start_at: '2026-10-01T13:00:00.000Z' } };
    expect((await run({ type: 'tech_late', severity: 'warn', job_id: 'visit-1', payload })).lateAlert)
      .toEqual({ type: 'tech_late', severity: 'warn', minutesLate: null, missingTracking: true, visitId: 'visit-1', windowStart: '09:00:00', visitType: 'Pest Control', windowDisplay: '9:00 AM–11:00 AM' });
  });

  test('with two visits today the alert names the visit it was raised on', async () => {
    const out = await loadVisitLoops({
      customerId: 'c1', now: NOW, deriveWindow,
      upcomingServices: [todayEntry(), todayEntry({ scheduledServiceId: 'visit-2', type: 'Lawn Care' })],
      conn: fakeConn({
        scheduled_services: (ops, kind) => (hasOp(ops, 'leftJoin')
          ? [todayRow(), todayRow({ id: 'visit-2', service_type: 'Lawn Care', window_start: '14:00:00' })]
          : (kind === 'first' ? null : [])),
        dispatch_alerts: () => [{ type: 'tech_late', severity: 'warn', job_id: 'visit-2', payload: { delay_minutes: 20, scheduled_date: '2026-10-01', window_start: '14:00:00' } }],
      }),
    });
    expect(out.lateAlert).toMatchObject({ visitType: 'Lawn Care', minutesLate: 20 });
  });

  test('an alert left over from before a same-day reschedule is not current lateness', async () => {
    // the visit is now 09:00; the alert recorded the old 13:00 window (tech-late) or old promise (no-show)
    expect((await run({ type: 'tech_late', severity: 'warn', job_id: 'visit-1', payload: { delay_minutes: 30, scheduled_date: '2026-10-01', window_start: '13:00:00' } })).lateAlert).toBeNull();
    expect((await run({ type: 'tech_late', severity: 'warn', job_id: 'visit-1', payload: { delay_minutes: 30, scheduled_date: '2026-09-30', window_start: '09:00:00' } })).lateAlert).toBeNull();
    expect((await run({ type: 'tech_late', severity: 'warn', job_id: 'visit-1', payload: { evidence: 'missing_tracking', promised_window: { start_at: '2026-10-01T17:00:00.000Z' } } })).lateAlert).toBeNull();
    // matching occurrence: kept
    expect((await run({ type: 'tech_late', severity: 'warn', job_id: 'visit-1', payload: { delay_minutes: 30, scheduled_date: '2026-10-01', window_start: '09:00:00' } })).lateAlert).toMatchObject({ minutesLate: 30 });
    expect((await run({ type: 'tech_late', severity: 'warn', job_id: 'visit-1', payload: { evidence: 'missing_tracking', promised_window: { start_at: '2026-10-01T13:00:00.000Z' } } })).lateAlert).toMatchObject({ missingTracking: true });
  });

  test('no minutes in the payload: minutesLate null; no open alert: null', async () => {
    expect((await run({ type: 'tech_late', severity: 'info', job_id: 'visit-1', payload: { scheduled_date: '2026-10-01', window_start: '09:00:00' } })).lateAlert.minutesLate).toBeNull();
    // an unstamped alert (null or empty payload) cannot be shown to be about this occurrence
    expect((await run({ type: 'tech_late', severity: 'info', job_id: 'visit-1', payload: null })).lateAlert).toBeNull();
    expect((await run({ type: 'tech_late', severity: 'info', job_id: 'visit-1', payload: { delay_minutes: 30 } })).lateAlert).toBeNull();
    expect((await run(null)).lateAlert).toBeNull();
  });

  test('queries only unresolved alerts of the two overdue types for today\'s visit ids', async () => {
    const conn = fakeConn({
      scheduled_services: (ops) => (hasOp(ops, 'leftJoin') ? [todayRow()] : null),
      dispatch_alerts: () => null,
    });
    await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, conn });
    const q = conn.calls.find((c) => c.table === 'dispatch_alerts');
    expect(hasOp(q.ops, 'whereNull', (a) => a[0] === 'resolved_at')).toBe(true);
    expect(hasOp(q.ops, 'whereIn', (a) => a[0] === 'type' && a[1].join() === 'tech_late,unassigned_overdue')).toBe(true);
    expect(hasOp(q.ops, 'whereIn', (a) => a[0] === 'job_id' && a[1].join() === 'visit-1')).toBe(true);
  });
});

describe('pastWindow', () => {
  const run = (row, now = NOW) => loadVisitLoops({
    customerId: 'c1', upcomingServices: [todayEntry()], now, deriveWindow,
    conn: fakeConn({ scheduled_services: (ops, kind) => (hasOp(ops, 'leftJoin') ? [todayRow(row)] : (kind === 'first' ? null : [])) }),
  });

  test('a pending visit past its customer-facing window (start + 2h, not the internal block) reads passed', async () => {
    // window_start 09:00, internal window_end 10:00, customer window 9-11; it is 12:00.
    const out = await run({ status: 'pending' });
    expect(out.pastWindow).toEqual({ visitId: 'visit-1', windowStart: '09:00:00', type: 'Pest Control', windowDisplay: '9:00 AM–11:00 AM', minutesPast: 60 });
  });

  test('inside the customer-facing window (even past the internal window_end) is not passed', async () => {
    const out = await run({ status: 'confirmed' }, new Date('2026-10-01T14:30:00Z')); // 10:30 ET
    expect(out.pastWindow).toBeNull();
  });

  test('a started visit, or one whose tracker is live, is never "passed"', async () => {
    expect((await run({ status: 'on_site' })).pastWindow).toBeNull();
    expect((await run({ status: 'pending', track_state: 'en_route' })).pastWindow).toBeNull();
  });

  test('performed but not closed (tracker complete, or a service record) is never "passed"', async () => {
    expect((await run({ status: 'confirmed', track_state: 'complete' })).pastWindow).toBeNull();
    const conn = fakeConn({
      scheduled_services: (ops, kind) => (hasOp(ops, 'leftJoin') ? [todayRow({ status: 'pending' })] : (kind === 'first' ? null : [])),
      service_records: () => [{ scheduled_service_id: 'visit-1' }],
    });
    expect((await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, deriveWindow, conn })).pastWindow).toBeNull();
  });

  test('a window that crosses midnight (23:00-01:00) is not passed in the evening', async () => {
    const out = await run({ status: 'confirmed', window_start: '23:00:00', window_end: '23:30:00' }, new Date('2026-10-02T02:00:00Z')); // 22:00 ET
    expect(out.pastWindow).toBeNull();
  });

  test('no start time: no promised cutoff (window_end is the internal job block, never an arrival window)', async () => {
    const out = await run({ status: 'pending', window_start: null, window_end: '11:30:00' });
    expect(out.pastWindow).toBeNull();
  });

  test('no visit note is ever read into the facts', async () => {
    const out = await run({ status: 'en_route', notes: 'landlord pays, gate code 1234' });
    expect(out).not.toHaveProperty('liveNote');
    expect(JSON.stringify(out)).not.toContain('landlord');
  });
});

describe('missedVisit', () => {
  const run = ({ unfinished = null, noshow = null, later = [] }) => loadVisitLoops({
    customerId: 'c1', upcomingServices: [], now: NOW, deriveWindow,
    conn: fakeConn({
      scheduled_services: (ops) => (isUnfinishedQuery(ops) ? (unfinished ? [].concat(unfinished) : []) : later),
      reschedule_log: () => (noshow ? [].concat(noshow) : []),
    }),
  });

  test('a pending visit from the last week reads as not completed', async () => {
    const out = await run({ unfinished: { id: 'v0', service_type: 'Lawn Care', scheduled_date: '2026-09-29', window_start: '09:00:00', status: 'confirmed' } });
    expect(out.missedVisit).toEqual({ type: 'Lawn Care', date: '2026-09-29', windowStart: '09:00:00', windowDisplay: '9:00 AM–11:00 AM', status: 'confirmed', reason: 'not_completed' });
  });

  test('queries the last 7 ET days, before today, pending/confirmed only', async () => {
    const conn = fakeConn({ scheduled_services: () => null, reschedule_log: () => null });
    await loadVisitLoops({ customerId: 'c1', upcomingServices: [], now: NOW, conn });
    const q = conn.calls.find((c) => c.table === 'scheduled_services' && isUnfinishedQuery(c.ops));
    expect(hasOp(q.ops, 'where', (a) => a[0] === 'scheduled_date' && a[1] === '<' && a[2] === '2026-10-01')).toBe(true);
    expect(hasOp(q.ops, 'where', (a) => a[0] === 'scheduled_date' && a[1] === '>=' && a[2] === '2026-09-24')).toBe(true);
    // ET calendar days across spring DST: 00:30 EDT on Mar 9 2026 looks back to Mar 2, not Mar 1
    const dst = fakeConn({ scheduled_services: () => null, reschedule_log: () => null });
    await loadVisitLoops({ customerId: 'c1', upcomingServices: [], now: new Date('2026-03-09T04:30:00Z'), conn: dst });
    const dq = dst.calls.find((c) => c.table === 'scheduled_services' && isUnfinishedQuery(c.ops));
    expect(hasOp(dq.ops, 'where', (a) => a[0] === 'scheduled_date' && a[1] === '>=' && a[2] === '2026-03-02')).toBe(true);
    expect(hasOp(q.ops, 'whereIn', (a) => a[0] === 'status' && a[1].join() === 'pending,confirmed')).toBe(true);
    // performed-but-not-closed rows are excluded: a tracker 'complete' or a written service record
    expect(hasOp(q.ops, 'where', (a) => typeof a[0] === 'function')).toBe(true);
    expect(hasOp(q.ops, 'whereNotExists')).toBe(true);
  });

  test('a soft no-show moved later the SAME day (new_date set, row still live) is not a miss', async () => {
    const noshow = { scheduled_service_id: 'v9', original_date: '2026-10-01', original_window: '9-11 AM', new_date: '2026-10-01', service_type: 'Pest Control', window_start: '15:00:00', status: 'confirmed' };
    expect((await run({ noshow })).missedVisit).toBeNull();
  });

  test('a same-day replacement visit counts as the follow-up; the logged row itself never does', async () => {
    const noshow = { scheduled_service_id: 'v9', property_id: 'prop-A', original_date: '2026-10-01', original_window: '09:00:00-10:00:00', new_date: null, service_type: 'Pest Control', status: 'no_show' };
    const conn = fakeConn({ scheduled_services: (ops) => (isUnfinishedQuery(ops) ? [] : [{ service_type: 'Pest Control', scheduled_date: '2026-10-01', window_start: '15:00:00' }]), reschedule_log: () => [noshow] });
    const out = await loadVisitLoops({ customerId: 'c1', upcomingServices: [], now: NOW, deriveWindow, conn });
    expect(out.missedVisit).toBeNull();
    const probe = conn.calls.find((c) => c.table === 'scheduled_services' && c.terminal === 'all' && !isUnfinishedQuery(c.ops) && !hasOp(c.ops, 'leftJoin'));
    expect(hasOp(probe.ops, 'where', (a) => a[0] === 'scheduled_date' && a[1] === '>=' && a[2] === '2026-10-01')).toBe(true);
  });

  test('the missed window is the promised arrival window from the logged start, never the stored job-block end or the moved row', async () => {
    // writers store "start-end" with the internal block as the end (missed-appointment.js)
    const noshow = { original_date: '2026-09-30', original_window: '09:00:00-10:30:00', service_type: 'Mosquito Control', window_start: '13:00:00', status: 'no_show' };
    expect((await run({ noshow })).missedVisit).toMatchObject({ windowDisplay: '9:00 AM–11:00 AM' });
    expect((await run({ noshow: { ...noshow, original_window: null } })).missedVisit).toMatchObject({ windowDisplay: null });
  });

  test('a replacement at ANOTHER property does not resolve the miss', async () => {
    const noshow = { scheduled_service_id: 'v9', property_id: 'prop-A', original_date: '2026-09-30', original_window: '09:00:00-10:00:00', new_date: null, service_type: 'Pest Control', status: 'no_show' };
    const conn = fakeConn({ scheduled_services: () => [], reschedule_log: () => [noshow] });
    await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn });
    const probe = conn.calls.find((c) => c.table === 'scheduled_services' && !isUnfinishedQuery(c.ops) && !hasOp(c.ops, 'leftJoin') && hasOp(c.ops, 'whereIn'));
    // the query's modify() narrows to the logged row's property (and never the row itself)
    const seen = [];
    const stub = { where: (...a) => { seen.push(['where', ...a]); return stub; }, whereNot: (...a) => { seen.push(['whereNot', ...a]); return stub; } };
    probe.ops.filter((o) => o.op === 'modify').forEach((o) => o.args[0](stub));
    expect(seen).toEqual(expect.arrayContaining([['where', 'property_id', 'prop-A'], ['whereNot', 'id', 'v9']]));
  });

  test('a no-show logged without new_date, later rebooked or completed on the SAME row, is resolved', async () => {
    const base = { scheduled_service_id: 'v9', original_date: '2026-09-30', original_window: '09:00:00-10:00:00', new_date: null, service_type: 'Pest Control' };
    const run1 = (noshow) => loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn: fakeConn({ scheduled_services: () => [], reschedule_log: () => [noshow] }) });
    // rebooked to another day, or to a later window the same day, or completed
    expect((await run1({ ...base, ss_scheduled_date: '2026-10-03', window_start: '09:00:00', status: 'confirmed' })).missedVisit).toBeNull();
    expect((await run1({ ...base, ss_scheduled_date: '2026-09-30', window_start: '15:00:00', status: 'confirmed' })).missedVisit).toBeNull();
    expect((await run1({ ...base, ss_scheduled_date: '2026-09-30', window_start: '09:00:00', status: 'completed' })).missedVisit).toBeNull();
    // performed in the original slot after all (lagging status): tracker complete or a service record
    expect((await run1({ ...base, ss_scheduled_date: '2026-09-30', window_start: '09:00:00', status: 'confirmed', track_state: 'complete' })).missedVisit).toBeNull();
    expect((await run1({ ...base, ss_scheduled_date: '2026-09-30', window_start: '09:00:00', status: 'no_show', recorded: true })).missedVisit).toBeNull();
    // still the missed occurrence, untouched: still missed
    expect((await run1({ ...base, ss_scheduled_date: '2026-09-30', window_start: '09:00:00', status: 'confirmed' })).missedVisit).toMatchObject({ reason: 'customer_noshow' });
    expect((await run1({ ...base, ss_scheduled_date: '2026-09-30', window_start: '09:00:00', status: 'no_show' })).missedVisit).toMatchObject({ reason: 'customer_noshow' });
  });

  test('a same-day visit counts as the follow-up only when it starts AFTER the missed slot', async () => {
    const noshow = { scheduled_service_id: 'v9', property_id: 'prop-A', original_date: '2026-09-30', original_window: '13:00:00-14:00:00', new_date: null, service_type: 'Pest Control', status: 'no_show' };
    const at = (later) => loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn: fakeConn({ scheduled_services: (ops) => (isUnfinishedQuery(ops) ? [] : later), reschedule_log: () => [noshow] }) });
    // a morning pest visit that day preceded the 1 PM no-show: not a replacement
    expect((await at([{ service_type: 'Pest Control', scheduled_date: '2026-09-30', window_start: '09:00:00' }])).missedVisit).toMatchObject({ reason: 'customer_noshow' });
    // a 4 PM visit that day, or any later day: a replacement
    expect((await at([{ service_type: 'Pest Control', scheduled_date: '2026-09-30', window_start: '16:00:00' }])).missedVisit).toBeNull();
    expect((await at([{ service_type: 'Pest Control', scheduled_date: '2026-10-02', window_start: '09:00:00' }])).missedVisit).toBeNull();
  });

  test('a rebooked newest no-show does not hide an older open one', async () => {
    const rebooked = { scheduled_service_id: 'v9', original_date: '2026-09-30', original_window: '09:00:00-10:00:00', new_date: '2026-10-03', service_type: 'Pest Control', status: 'confirmed' };
    const open = { scheduled_service_id: 'v8', original_date: '2026-09-27', original_window: '09:00:00-10:00:00', new_date: null, service_type: 'Mosquito Control', status: 'no_show' };
    expect((await run({ noshow: [rebooked, open] })).missedVisit).toMatchObject({ type: 'Mosquito Control', date: '2026-09-27', reason: 'customer_noshow' });
  });

  test('yesterday\'s 23:00 visit is not missed while its window (to 01:00) is still open', async () => {
    const late = { id: 'v7', service_type: 'Pest Control', scheduled_date: '2026-09-30', window_start: '23:00:00', window_end: '23:45:00', status: 'confirmed' };
    const at = (iso) => loadVisitLoops({ customerId: 'c1', now: new Date(iso), deriveWindow, conn: fakeConn({ scheduled_services: (ops) => (isUnfinishedQuery(ops) ? [late] : []), reschedule_log: () => [] }) });
    expect((await at('2026-10-01T04:30:00Z')).missedVisit).toBeNull(); // 00:30 ET
    expect((await at('2026-10-01T05:30:00Z')).missedVisit).toMatchObject({ date: '2026-09-30', reason: 'not_completed' }); // 01:30 ET
  });

  test('a customer no-show not followed by a later visit of the same service counts', async () => {
    const out = await run({ noshow: { original_date: '2026-09-30', service_type: 'Mosquito Control', window_start: '13:00:00', status: 'no_show' } });
    expect(out.missedVisit).toMatchObject({ type: 'Mosquito Control', date: '2026-09-30', reason: 'customer_noshow', status: 'no_show' });
  });

  test('a no-show already followed by a later visit of the same family is not missed; another family does not cancel it', async () => {
    const noshow = { property_id: 'prop-A', original_date: '2026-09-30', service_type: 'Mosquito Control', window_start: null, status: 'no_show' };
    expect((await run({ noshow, later: [{ service_type: 'Mosquito Barrier Spray', scheduled_date: '2026-10-03' }] })).missedVisit).toBeNull();
    expect((await run({ noshow, later: [{ service_type: 'Lawn Care', scheduled_date: '2026-10-03' }] })).missedVisit).toMatchObject({ reason: 'customer_noshow' });
  });

  test('no property on the missed row: another visit cannot prove the follow-up (fail closed, no probe)', async () => {
    const noshow = { scheduled_service_id: 'v9', property_id: null, original_date: '2026-09-30', original_window: '09:00:00-10:00:00', service_type: 'Mosquito Control', status: 'no_show' };
    const conn = fakeConn({ scheduled_services: (ops) => (isUnfinishedQuery(ops) ? [] : [{ service_type: 'Mosquito Control', scheduled_date: '2026-10-03' }]), reschedule_log: () => [noshow] });
    const out = await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn });
    expect(out.missedVisit).toMatchObject({ reason: 'customer_noshow' });
    expect(conn.calls.some((c) => c.table === 'scheduled_services' && !isUnfinishedQuery(c.ops) && !hasOp(c.ops, 'leftJoin'))).toBe(false);
  });

  test('both present: the most recent date wins', async () => {
    const out = await run({
      unfinished: { id: 'v0', service_type: 'Lawn Care', scheduled_date: '2026-09-26', status: 'pending' },
      noshow: { original_date: '2026-09-30', service_type: 'Pest Control', status: 'no_show' },
    });
    expect(out.missedVisit).toMatchObject({ date: '2026-09-30', reason: 'customer_noshow' });
  });

  test('a recurring child that already existed before the no-show was logged is not a follow-up', async () => {
    const noshow = { scheduled_service_id: 'v9', property_id: 'prop-A', logged_at: '2026-09-30T15:00:00Z', original_date: '2026-09-30', original_window: '09:00:00-10:00:00', service_type: 'Pest Control', status: 'no_show' };
    const conn = fakeConn({ scheduled_services: () => [], reschedule_log: () => [noshow] });
    await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn });
    const probe = conn.calls.find((c) => c.table === 'scheduled_services' && !isUnfinishedQuery(c.ops) && !hasOp(c.ops, 'leftJoin') && hasOp(c.ops, 'whereIn'));
    const seen = [];
    const stub = { where: (...a) => { seen.push(['where', ...a]); return stub; }, whereNot: (...a) => { seen.push(['whereNot', ...a]); return stub; } };
    probe.ops.filter((o) => o.op === 'modify').forEach((o) => o.args[0](stub));
    expect(seen).toContainEqual(['where', 'created_at', '>', '2026-09-30T15:00:00Z']);
  });

  test('familyKey buckets', () => {
    expect(familyKey('Tree & Shrub Fertilization')).toBe('tree_shrub');
    // word-bounded: "Plant Health Program" is not ants; "Pirate" is not rats
    expect(familyKey('Plant Health Program')).not.toBe('pest');
    expect(familyKey('Fire Ant Treatment')).toBe('pest');
    expect(familyKey('Rat Exclusion')).toBe('rodent');
    expect(familyKey('Lawn Fertilization')).toBe('lawn');
    expect(familyKey('Quarterly Pest Control')).toBe('pest');
    expect(familyKey('Mosquito Barrier')).toBe('mosquito');
    expect(familyKey(null)).toBeNull();
  });
});

describe('weOwe and customerWaiting', () => {
  const callRow = (over) => ({ id: 'c-1', party: 'waves', kind: 'send_estimate', description: 'Send the estimate', due_text: 'by tomorrow', due_at: null, effective_due_at: null, call_started_at: '2026-09-30T14:00:00Z', ...over });
  const smsRow = (over) => ({ id: 's-1', party: 'waves', kind: 'callback', description: 'Call back about ants', due_at: '2026-10-01T21:00:00Z', sms_started_at: '2026-10-01T10:00:00Z', channel: 'sms', ...over });
  const run = (conn) => loadVisitLoops({ customerId: 'c1', upcomingServices: [], now: NOW, conn });
  const ctxConn = (contexts) => fakeConn({ call_commitments: () => Object.entries(contexts).map(([id, sms_context]) => ({ id, sms_context })) });

  test('sms/email gates off: their reader is not called; call promises are still read (write gate only)', async () => {
    const out = await run(ctxConn({}));
    expect(out.weOwe).toEqual([]);
    expect(out.customerWaiting).toEqual([]);
    expect(listOpenCommitments).toHaveBeenCalled();
    expect(listSmsCommitments).not.toHaveBeenCalled();
  });

  test('call gate OFF: waves-party call promises become weOwe; customer-party call rows appear nowhere', async () => {
    featureGates.gates.callCommitments = false;
    listOpenCommitments.mockResolvedValue([
      callRow({}),
      callRow({ id: 'c-2', party: 'customer', kind: 'send_photos', description: 'Send photos of the fence', call_started_at: '2026-09-29T14:00:00Z' }),
    ]);
    const out = await run(ctxConn({}));
    expect(listOpenCommitments).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ customerId: 'c1', party: 'waves', limit: 50 }));
    // no resolved deadline: the spoken words, dated to the call
    expect(out.weOwe).toEqual([{ id: 'c-1', rev: expect.stringMatching(/^[0-9a-f]{12}$/), kind: 'send_estimate', description: 'Send the estimate', since: '2026-09-30', source: 'call' }]);
    expect(out.customerWaiting).toEqual([]);
    expect(out.weOwe).toHaveLength(1);
  });

  test('sms gate on: basis request is the customer waiting, basis promise is ours; each carries the day it was asked', async () => {
    smsCommitmentsEnabled.mockReturnValue(true);
    listSmsCommitments.mockResolvedValue([
      smsRow({ id: 's-1' }),
      smsRow({ id: 's-2', kind: 'send_report', description: 'Report requested', due_at: null, sms_started_at: '2026-09-30T10:00:00Z' }),
    ]);
    const out = await run(ctxConn({ 's-1': { basis: 'promise', due_text: 'later today' }, 's-2': { basis: 'request' } }));
    expect(out.weOwe).toEqual([{ id: 's-1', rev: expect.any(String), kind: 'callback', description: 'Call back about ants', since: '2026-10-01', source: 'sms' }]);
    expect(out.customerWaiting).toEqual([{ id: 's-2', rev: expect.any(String), kind: 'send_report', description: 'Report requested', since: '2026-09-30' }]);
  });

  test('a human promise added later to an older call is dated (and sorted) by its own creation, like the canonical timing', async () => {
    listOpenCommitments.mockResolvedValue([
      callRow({ id: 'c-old', description: 'old ai promise', call_started_at: '2026-09-20T14:00:00Z' }),
      callRow({ id: 'c-human', source: 'human', description: 'added today', call_started_at: '2026-09-20T14:00:00Z', created_at: '2026-10-01T13:00:00Z' }),
    ]);
    const out = await run(ctxConn({}));
    expect(out.weOwe[0]).toMatchObject({ id: 'c-human', since: '2026-10-01' });
    expect(out.weOwe[1]).toMatchObject({ id: 'c-old', since: '2026-09-20' });
  });

  test('no deadline is ever restated (stated, default reminder, floor, snooze or passed)', async () => {
    listOpenCommitments.mockResolvedValue([callRow({ due_at: '2026-09-28T21:00:00Z', effective_due_at: '2026-10-02T21:00:00Z', due_type: 'floor', due_basis: 'default_kind' })]);
    const [item] = (await run(ctxConn({}))).weOwe;
    expect(item).not.toHaveProperty('dueText');
    expect(JSON.stringify(item)).not.toMatch(/2026-09-28|2026-10-02/);
    expect(item.since).toBe('2026-09-30'); // the day it was asked anchors any relative wording in the description
  });

  test('the revision changes when staff edit the wording or kind, and only then', async () => {
    const { commitmentRevision } = require('../services/visit-loops-facts');
    const base = { kind: 'callback', description: 'Call back', due_at: '2026-10-01T21:00:00Z' };
    expect(commitmentRevision(base)).toBe(commitmentRevision({ ...base, due_at: '2026-10-02T21:00:00Z' }));
    expect(commitmentRevision({ ...base, description: 'Call back after 3' })).not.toBe(commitmentRevision(base));
    expect(commitmentRevision({ ...base, kind: 'send_estimate' })).not.toBe(commitmentRevision(base));
  });

  test('email rows need their own gate; sms off + email on keeps only email rows', async () => {
    process.env.GATE_EMAIL_OPERATIONAL_ACTIONS = 'true';
    listSmsCommitments.mockResolvedValue([smsRow({ id: 's-1' }), smsRow({ id: 'e-1', channel: 'email', description: 'Send the quote' })]);
    const out = await run(ctxConn({ 'e-1': { basis: 'promise' } }));
    expect(out.weOwe).toEqual([expect.objectContaining({ description: 'Send the quote', source: 'email' })]);
    // only the enabled channel is read, so the page limit bounds rendered rows
    expect(listSmsCommitments).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ channels: ['email'] }));
    // and each rendered lane is its own page: promises can't crowd out requests or vice versa
    expect(listSmsCommitments).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lane: 'promise' }));
    expect(listSmsCommitments).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ lane: 'request' }));
  });

  test('descriptions are redacted BEFORE the 120-char clip (a straddling code never survives)', async () => {
    smsCommitmentsEnabled.mockReturnValue(true);
    listSmsCommitments.mockResolvedValue([smsRow({ id: 's-1', description: `${'x'.repeat(110)} 4545 is the gate code` })]);
    const out = await run(ctxConn({ 's-1': { basis: 'promise' } }));
    expect(out.weOwe[0].description).not.toContain('4545');
  });

  test('dedupe by id, newest first, capped at 5, description capped at 120', async () => {
    featureGates.gates.callCommitments = true;
    smsCommitmentsEnabled.mockReturnValue(true);
    listOpenCommitments.mockResolvedValue(Array.from({ length: 4 }, (_, i) => callRow({ id: `c-${i}`, description: `call ${i}`, call_started_at: `2026-09-2${i}T14:00:00Z` })));
    listSmsCommitments.mockResolvedValue([
      smsRow({ id: 'c-0', description: 'dup of call 0' }), // same id: dropped
      smsRow({ id: 's-9', description: 'y'.repeat(200), sms_started_at: '2026-10-01T10:00:00Z' }),
      smsRow({ id: 's-8', description: 'older sms', sms_started_at: '2026-09-18T10:00:00Z' }),
    ]);
    const out = await run(ctxConn({ 's-9': { basis: 'promise' }, 's-8': { basis: 'promise' } }));
    expect(out.weOwe).toHaveLength(5);
    expect(out.weOwe[0].description).toHaveLength(120);
    expect(out.weOwe.map((w) => w.description)).not.toContain('dup of call 0');
    expect(out.weOwe.map((w) => w.description)).not.toContain('older sms');
  });

  test('a failing reader empties only commitments; a failed context lookup falls back to "ours" by party', async () => {
    featureGates.gates.callCommitments = true;
    listOpenCommitments.mockRejectedValue(new Error('db'));
    expect((await run(ctxConn({}))).weOwe).toEqual([]);
    listOpenCommitments.mockResolvedValue([]);
    smsCommitmentsEnabled.mockReturnValue(true);
    listSmsCommitments.mockResolvedValue([smsRow({ id: 's-1' })]);
    const conn = fakeConn({ call_commitments: () => { throw new Error('ctx'); } });
    expect((await run(conn)).weOwe).toHaveLength(1);
  });
});
