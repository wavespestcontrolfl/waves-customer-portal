/**
 * visit-loops-facts: the read-only "visit status and open loops" facts
 * (tech position, late alert, passed window, missed visit, live note, promises
 * we owe, asks still waiting). Mocked db; no network. Synthetic data only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/call-commitments', () => ({ listOpenCommitments: jest.fn() }));
jest.mock('../services/sms-operational-actions', () => ({ smsCommitmentsEnabled: jest.fn(), listSmsCommitments: jest.fn() }));
// the no-show detector's promise evidence (what the customer was actually sent): none by default
// (the stop resolution — byVisit / groupedStops / stopPromise — is the real one)
jest.mock('../services/no-show-detector', () => ({
  ...jest.requireActual('../services/no-show-detector'),
  loadPromiseEvents: jest.fn(async () => []),
  promisedVisitIds: jest.fn(async () => []),
}));
const { loadPromiseEvents, promisedVisitIds } = require('../services/no-show-detector');

const logger = require('../services/logger');
const featureGates = require('../config/feature-gates');
const { listOpenCommitments } = require('../services/call-commitments');
const { smsCommitmentsEnabled, listSmsCommitments } = require('../services/sms-operational-actions');
const { loadVisitLoops, emptyVisitLoops } = require('../services/visit-loops-facts');

// 2026-10-01 12:00 ET (EDT, UTC-4).
const NOW = new Date('2026-10-01T16:00:00Z');
const _minutesAgo = (n) => new Date(NOW.getTime() - n * 60000);

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
// the passed-window candidate read (the customer's not-started rows from yesterday on)
const isCandidateQuery = (ops) => hasOp(ops, 'where', (a) => a[0] === 'scheduled_date' && a[1] === '>=');

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

  test('strict skips commitments unless withCommitments (the gratitude boundary needs them)', async () => {
    listOpenCommitments.mockResolvedValue([{ id: 'c-1', party: 'waves', kind: 'callback', description: 'x', call_started_at: '2026-09-30T14:00:00Z' }]);
    const conn = fakeConn({ call_commitments: () => [] });
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, conn, strict: true })).weOwe).toEqual([]);
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, conn, strict: true, withCommitments: true })).weOwe).toHaveLength(1);
  });

  test('strict + withCommitments: a failing commitment reader throws (never "nothing owed")', async () => {
    listOpenCommitments.mockRejectedValueOnce(new Error('call reader down'));
    await expect(loadVisitLoops({ customerId: 'c1', now: NOW, conn: fakeConn({}), strict: true, withCommitments: true })).rejects.toThrow('call reader down');
    smsCommitmentsEnabled.mockReturnValue(true);
    listSmsCommitments.mockRejectedValueOnce(new Error('sms reader down'));
    await expect(loadVisitLoops({ customerId: 'c1', now: NOW, conn: fakeConn({}), strict: true, withCommitments: true })).rejects.toThrow('sms reader down');
  });

  test('strict (send-time rebuild): a failed read throws instead of reading as empty', async () => {
    const conn = () => { throw new Error('db down'); };
    await expect(loadVisitLoops({ customerId: 'c1', now: NOW, conn, strict: true })).rejects.toThrow('db down');
  });

  test('the signature keys on the occurrence (visit, date, window) and the service, never on display labels', () => {
    const { visitStatusSignature } = require('../services/visit-loops-facts');
    const late = { visitId: 'v1', windowStart: '09:00:00', scheduledDate: '2026-10-01', visitType: 'Pest Control', type: 'tech_late', missingTracking: false, windowDisplay: '9–11' };
    const base = visitStatusSignature({ lateAlert: late });
    expect(visitStatusSignature({ lateAlert: { ...late, windowStart: '13:00:00' } })).not.toBe(base);
    // the same row and hour moved to another day is a different occurrence
    expect(visitStatusSignature({ lateAlert: { ...late, scheduledDate: '2026-10-02' } })).not.toBe(base);
    // a staff correction of the service the line names
    expect(visitStatusSignature({ lateAlert: { ...late, visitType: 'Lawn Care' } })).not.toBe(base);
    expect(visitStatusSignature({ lateAlert: { ...late, missingTracking: true } })).not.toBe(base);
    expect(visitStatusSignature({ lateAlert: { ...late, windowDisplay: '9:00 AM–11:00 AM' } })).toBe(base);
    expect(visitStatusSignature({ pastWindow: { visitId: 'v1', windowStart: '09:00:00', type: 'Lawn' } })).not.toBe(visitStatusSignature({ pastWindow: { visitId: 'v1', windowStart: '09:00:00', type: 'Pest' } }));
    // unassigned after drafting: the reply's "checking with the tech" is stale
    expect(visitStatusSignature({ pastWindow: { visitId: 'v1', windowStart: '09:00:00', assigned: true } })).not.toBe(visitStatusSignature({ pastWindow: { visitId: 'v1', windowStart: '09:00:00', assigned: false } }));
    expect(visitStatusSignature({ pastWindow: { visitId: 'v1', windowStart: '09:00:00' } })).not.toBe(visitStatusSignature({ pastWindow: { visitId: 'v1', windowStart: '10:00:00' } }));
    expect(visitStatusSignature({})).toBeNull();
  });

  test('a db that throws on every call never throws out: all fields empty, warnings logged', async () => {
    const conn = () => { throw new Error('db down'); };
    const out = await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, conn });
    expect(out).toEqual(emptyVisitLoops());
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('lateAlert', () => {
  // the read joins each open alert to its visit: a fixture is the alert + the visit's columns
  const alertRow = (alert, visit = {}) => ({ type: 'tech_late', severity: 'warn', ...alert, ...todayRow({ status: 'en_route', ...visit }) });
  const run = (rows, now = NOW) => loadVisitLoops({
    customerId: 'c1', now, deriveWindow,
    conn: fakeConn({ scheduled_services: () => [], dispatch_alerts: () => [].concat(rows || []) }),
  });
  const STAMP = { scheduled_date: '2026-10-01', window_start: '09:00:00' };
  const which = { visitId: 'visit-1', windowStart: '09:00:00', scheduledDate: '2026-10-01', visitType: 'Pest Control', windowDisplay: '9:00 AM–11:00 AM' };

  test('an open alert carries type and severity, never the frozen payload minutes (string or object payload)', async () => {
    expect((await run(alertRow({ payload: JSON.stringify({ delay_minutes: 35, ...STAMP }) }))).lateAlert)
      .toEqual({ type: 'tech_late', severity: 'warn', missingTracking: false, ...which });
    expect((await run(alertRow({ type: 'unassigned_overdue', severity: 'critical', payload: { delay_minutes: '12', ...STAMP } }))).lateAlert)
      .toEqual({ type: 'unassigned_overdue', severity: 'critical', missingTracking: false, ...which });
  });

  test('a no-show-detector STAGE 2 alert (30 min after the promised window, no arrival) is a delay, departed or not', async () => {
    for (const departed of [true, false]) {
      const payload = { source: 'no_show_detector', evidence: 'missing_tracking', stage: 2, departed, promised_window: { start_at: '2026-10-01T13:00:00.000Z' } };
      expect((await run(alertRow({ payload }))).lateAlert).toMatchObject({ missingTracking: false, visitId: 'visit-1' });
    }
  });

  test('a lagging member of a stop whose sibling is underway or done carries no delay', async () => {
    const delay = alertRow({ payload: STAMP }, { visit_id: 'g1', status: 'confirmed' });
    const conn = (advanced) => fakeConn({ scheduled_services: (ops) => (hasOp(ops, 'whereIn', (a) => a[0] === 'scheduled_date') ? advanced : []), dispatch_alerts: () => [delay] });
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn: conn([{ visit_id: 'g1', technician_id: 'tech-1', scheduled_date: '2026-10-01', window_start: '09:00:00' }]) })).lateAlert).toBeNull();
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn: conn([]) })).lateAlert).toMatchObject({ visitId: 'visit-1' });
    // the delay read asks only for ARRIVED or finished rows: an en-route row (the alerted visit itself) never suppresses it
    const seen = fakeConn({ scheduled_services: () => [], dispatch_alerts: () => [delay] });
    await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn: seen });
    const q = seen.calls.find((c) => c.table === 'scheduled_services' && hasOp(c.ops, 'whereIn', (a) => a[0] === 'scheduled_date'));
    const got = [];
    const stub = { whereIn: (...a) => { got.push(a); return stub; }, orWhereIn: (...a) => { got.push(a); return stub; }, orWhereExists: () => stub };
    q.ops.filter((o) => o.op === 'where' && typeof o.args[0] === 'function').forEach((o) => o.args[0](stub));
    expect(got).toEqual([['status', ['on_site', 'completed']], ['track_state', ['on_property', 'complete']]]);
  });

  test('a confirmed delay outranks a newer tracking gap on another visit', async () => {
    const gap = alertRow({ payload: { evidence: 'missing_tracking', stage: 1, promised_window: { start_at: '2026-10-01T18:00:00.000Z' } } }, { id: 'visit-2', service_type: 'Lawn Care', window_start: '14:00:00' });
    const delay = alertRow({ payload: STAMP });
    // newest first: the gap is newer, the delay older
    expect((await run([gap, delay])).lateAlert).toMatchObject({ visitId: 'visit-1', missingTracking: false });
    // only a gap: it still shows, as a gap
    expect((await run([gap])).lateAlert).toMatchObject({ visitId: 'visit-2', missingTracking: true });
  });

  test('a no-show-detector missing-tracking alert is a tracking gap, not lateness', async () => {
    const payload = { source: 'no_show_detector', evidence: 'missing_tracking', stage: 1, promised_window: { start_at: '2026-10-01T13:00:00.000Z' } };
    expect((await run(alertRow({ payload }))).lateAlert).toEqual({ type: 'tech_late', severity: 'warn', missingTracking: true, ...which });
  });

  test('the promised window holds after an uncommunicated internal move (the detector\'s promisedIds path)', async () => {
    // promised 9 AM today; staff moved the row to 3 PM today, or to next week, without telling the customer
    const payload = { source: 'no_show_detector', evidence: 'missing_tracking', promised_window: { start_at: '2026-10-01T13:00:00.000Z' } };
    for (const visit of [{ window_start: '15:00:00' }, { scheduled_date: '2026-10-08' }]) {
      expect((await run(alertRow({ payload }, visit))).lateAlert).toMatchObject({ visitId: 'visit-1', scheduledDate: '2026-10-01', windowStart: '09:00:00', windowDisplay: '9:00 AM–11:00 AM' });
    }
    // a promise for another day is not today's
    expect((await run(alertRow({ payload: { promised_window: { start_at: '2026-10-03T13:00:00.000Z' } } }))).lateAlert).toBeNull();
  });

  test('an overnight (23:00) visit\'s stage-2 alert stays live after its window ends; an ordinary yesterday alert does not', async () => {
    const payload = { source: 'no_show_detector', evidence: 'missing_tracking', stage: 2, promised_window: { start_at: '2026-10-01T03:00:00.000Z' } }; // 09-30 23:00 ET
    const at = new Date('2026-10-01T05:30:00Z'); // 01:30 ET, past the 01:00 end
    expect((await run(alertRow({ payload }, { scheduled_date: '2026-09-30', window_start: '23:00:00', status: 'en_route' }), at)).lateAlert).toMatchObject({ visitId: 'visit-1', scheduledDate: '2026-09-30' });
    const day = { source: 'no_show_detector', evidence: 'missing_tracking', stage: 2, promised_window: { start_at: '2026-09-30T13:00:00.000Z' } }; // 09-30 09:00 ET
    expect((await run(alertRow({ payload: day }, { scheduled_date: '2026-09-30' }), at)).lateAlert).toBeNull();
  });

  test('a 10 PM window (ends exactly at midnight) carries over: its alert stays live after midnight', async () => {
    const payload = { source: 'no_show_detector', evidence: 'missing_tracking', stage: 2, promised_window: { start_at: '2026-10-01T02:00:00.000Z' } }; // 09-30 22:00 ET
    expect((await run(alertRow({ payload }, { scheduled_date: '2026-09-30', window_start: '22:00:00' }), new Date('2026-10-01T04:45:00Z'))).lateAlert).toMatchObject({ scheduledDate: '2026-09-30' }); // 00:45 ET
  });

  test('an alert on a grouped member cancelled since is read through the stop\'s next live member', async () => {
    const payload = { source: 'no_show_detector', evidence: 'missing_tracking', stage: 2, promised_window: { start_at: '2026-10-01T13:00:00.000Z' } };
    const live = todayRow({ id: 'visit-2', visit_id: 'g1', status: 'confirmed', service_type: 'Lawn Care' });
    const conn = fakeConn({
      dispatch_alerts: () => [alertRow({ payload }, { visit_id: 'g1', status: 'cancelled' })],
      scheduled_services: (ops) => (hasOp(ops, 'whereIn', (x) => x[0] === 'ss.status' && x[1].includes('pending')) && hasOp(ops, 'whereIn', (x) => x[0] === 'ss.visit_id') ? [live] : []),
    });
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn })).lateAlert).toMatchObject({ visitId: 'visit-2', visitType: 'Lawn Care' });
    // no live member left: no delay
    const none = fakeConn({ dispatch_alerts: () => [alertRow({ payload }, { visit_id: 'g1', status: 'cancelled' })], scheduled_services: () => [] });
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn: none })).lateAlert).toBeNull();
  });

  test('the live-member hand-off excludes uncleared street-level holds; a started stop counts a service record', async () => {
    const payload = { source: 'no_show_detector', evidence: 'missing_tracking', stage: 2, promised_window: { start_at: '2026-10-01T13:00:00.000Z' } };
    const conn = fakeConn({ dispatch_alerts: () => [alertRow({ payload }, { visit_id: 'g1', status: 'cancelled' })], scheduled_services: () => [] });
    await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn });
    const handOff = conn.calls.find((c) => c.table === 'scheduled_services' && hasOp(c.ops, 'whereIn', (x) => x[0] === 'ss.visit_id'));
    expect(hasOp(handOff.ops, 'whereNotExists')).toBe(true);
    // the started-stop read: status, tracker OR a service record
    const started = conn.calls.find((c) => c.table === 'scheduled_services' && hasOp(c.ops, 'whereIn', (x) => x[0] === 'scheduled_date'));
    const inner = [];
    const b = new Proxy({}, { get: (_t, prop) => (...args) => { inner.push(prop); return b; } });
    started.ops.find((o) => o.op === 'where' && typeof o.args[0] === 'function').args[0](b);
    expect(inner).toEqual(expect.arrayContaining(['whereIn', 'orWhereIn', 'orWhereExists']));
  });

  test('an alert on a visit with a service record is excluded in the query (no stop key needed)', async () => {
    const conn = fakeConn({ dispatch_alerts: () => [], scheduled_services: () => [] });
    await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn });
    const q = conn.calls.find((c) => c.table === 'dispatch_alerts');
    const tables = [];
    for (const o of q.ops.filter((x) => x.op === 'whereNotExists')) {
      const b = new Proxy({}, { get: (_t, prop) => (...args) => { if (prop === 'from') tables.push(args[0]); return b; } });
      try { o.args[0].call(b); } catch { /* the hold subquery needs a real builder */ }
    }
    expect(tables).toContain('service_records as sr');
  });

  test('an alert on an uncleared street-level hold is excluded in the query', async () => {
    const conn = fakeConn({ dispatch_alerts: (ops) => (hasOp(ops, 'whereNotExists') ? [] : [{ type: 'tech_late' }]), scheduled_services: () => [] });
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn })).lateAlert).toBeNull();
  });

  test('a delivered reschedule obsoletes the alert\'s frozen promise before the detector reconciles it', async () => {
    const payload = { source: 'no_show_detector', evidence: 'missing_tracking', stage: 2, promised_window: { start_at: '2026-10-01T13:00:00.000Z' } };
    // the customer was since told 3 PM: the 9 AM delay is obsolete
    loadPromiseEvents.mockResolvedValueOnce([{ visit_id: 'visit-1', start_at: '2026-10-01T19:00:00.000Z', communicated_at: '2026-10-01T12:00:00Z' }]);
    expect((await run(alertRow({ payload }, { window_start: '15:00:00' }))).lateAlert).toBeNull();
    // a newer notice with an unknown window: obsolete too
    loadPromiseEvents.mockResolvedValueOnce([{ visit_id: 'visit-1', start_at: null, communicated_at: '2026-10-01T12:00:00Z' }]);
    expect((await run(alertRow({ payload }))).lateAlert).toBeNull();
    // the latest notice IS the alert's promise: it stands
    loadPromiseEvents.mockResolvedValueOnce([{ visit_id: 'visit-1', start_at: '2026-10-01T13:00:00.000Z', communicated_at: '2026-09-29T12:00:00Z' }]);
    expect((await run(alertRow({ payload }))).lateAlert).toMatchObject({ visitId: 'visit-1', missingTracking: false });
  });

  test('with two visits the alert names the visit it was raised on', async () => {
    const out = await run([alertRow({ payload: { scheduled_date: '2026-10-01', window_start: '14:00:00' } }, { id: 'visit-2', service_type: 'Lawn Care', window_start: '14:00:00' })]);
    expect(out.lateAlert).toMatchObject({ visitType: 'Lawn Care', visitId: 'visit-2' });
  });

  test('a schedule-stamped alert left over from before a reschedule is not current lateness', async () => {
    expect((await run(alertRow({ payload: { scheduled_date: '2026-10-01', window_start: '13:00:00' } }))).lateAlert).toBeNull();
    expect((await run(alertRow({ payload: { scheduled_date: '2026-09-30', window_start: '09:00:00' } }))).lateAlert).toBeNull();
    expect((await run(alertRow({ payload: STAMP }))).lateAlert).toMatchObject({ missingTracking: false });
  });

  test('an arrived, finished, cancelled or skipped visit never carries a delay, even with a lagging status', async () => {
    for (const visit of [{ status: 'confirmed', track_state: 'on_property' }, { status: 'confirmed', track_state: 'complete' }, { status: 'on_site' }, { status: 'confirmed', track_state: 'cancelled' }]) {
      expect((await run(alertRow({ payload: STAMP }, visit))).lateAlert).toBeNull();
    }
    expect((await run(alertRow({ payload: STAMP }, { status: 'confirmed', track_state: 'en_route' }))).lateAlert).toMatchObject({ visitId: 'visit-1' });
  });

  test('an unstamped alert (null or empty payload) or none: null', async () => {
    expect((await run(alertRow({ payload: null }))).lateAlert).toBeNull();
    expect((await run(alertRow({ payload: { delay_minutes: 30 } }))).lateAlert).toBeNull();
    expect((await run([])).lateAlert).toBeNull();
  });

  test('yesterday\'s 23:00 occurrence stays live past midnight, and after its 01:00 end while the alert is unresolved', async () => {
    const row = alertRow({ payload: { scheduled_date: '2026-09-30', window_start: '23:00:00' } }, { scheduled_date: '2026-09-30', window_start: '23:00:00' });
    expect((await run(row, new Date('2026-10-01T04:30:00Z'))).lateAlert).toMatchObject({ visitId: 'visit-1' }); // 00:30 ET
    expect((await run(row, new Date('2026-10-01T05:30:00Z'))).lateAlert).toMatchObject({ visitId: 'visit-1' }); // 01:30 ET
  });

  test('reads the customer\'s unresolved alerts of the two overdue types, joined to their visits', async () => {
    const conn = fakeConn({ scheduled_services: () => [], dispatch_alerts: () => [] });
    await loadVisitLoops({ customerId: 'c1', now: NOW, conn });
    const q = conn.calls.find((c) => c.table === 'dispatch_alerts');
    expect(hasOp(q.ops, 'join', (a) => a[0] === 'scheduled_services as ss')).toBe(true);
    expect(hasOp(q.ops, 'where', (a) => a[0] === 'ss.customer_id' && a[1] === 'c1')).toBe(true);
    expect(hasOp(q.ops, 'whereNull', (a) => a[0] === 'a.resolved_at')).toBe(true);
    expect(hasOp(q.ops, 'whereIn', (a) => a[0] === 'a.type' && a[1].join() === 'tech_late,unassigned_overdue')).toBe(true);
  });
});

describe('pastWindow', () => {
  const run = (row, now = NOW) => loadVisitLoops({
    customerId: 'c1', upcomingServices: [todayEntry()], now, deriveWindow,
    conn: fakeConn({ scheduled_services: (ops, kind) => (isCandidateQuery(ops) ? [todayRow(row)] : (kind === 'first' ? null : [])) }),
  });

  test('a pending visit past its customer-facing window (start + 2h, not the internal block) reads passed', async () => {
    // window_start 09:00, internal window_end 10:00, customer window 9-11; it is 12:00.
    const out = await run({ status: 'pending' });
    expect(out.pastWindow).toEqual({ visitId: 'visit-1', windowStart: '09:00:00', scheduledDate: '2026-10-01', type: 'Pest Control', windowDisplay: '9:00 AM–11:00 AM', minutesPast: 60, passedKeys: ['visit-1@2026-10-01T09:00:00'], assigned: true });
  });

  test('inside the customer-facing window (even past the internal window_end) is not passed', async () => {
    const out = await run({ status: 'confirmed' }, new Date('2026-10-01T14:30:00Z')); // 10:30 ET
    expect(out.pastWindow).toBeNull();
  });

  test('a lagging pending/confirmed row whose tracker is cancelled or skipped is never "passed"', async () => {
    for (const track_state of ['cancelled', 'skipped', 'complete', 'on_property']) {
      expect((await run({ status: 'confirmed', track_state })).pastWindow).toBeNull();
    }
    expect((await run({ status: 'confirmed', track_state: 'scheduled' })).pastWindow).toMatchObject({ visitId: 'visit-1' });
  });

  test('a started visit, or one whose tracker is live, is never "passed"', async () => {
    expect((await run({ status: 'on_site' })).pastWindow).toBeNull();
    expect((await run({ status: 'pending', track_state: 'en_route' })).pastWindow).toBeNull();
  });

  test('performed but not closed (tracker complete, or a service record) is never "passed"', async () => {
    expect((await run({ status: 'confirmed', track_state: 'complete' })).pastWindow).toBeNull();
    const conn = fakeConn({
      scheduled_services: (ops, kind) => (isCandidateQuery(ops) ? [todayRow({ status: 'pending' })] : (kind === 'first' ? null : [])),
      service_records: () => [{ scheduled_service_id: 'visit-1' }],
    });
    expect((await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, deriveWindow, conn })).pastWindow).toBeNull();
  });

  test('a lagging row is not "passed" when a sibling at the same stop (tech, day, window) is underway or done', async () => {
    const conn = (advanced) => fakeConn({ scheduled_services: (ops) => {
      if (isCandidateQuery(ops)) return [todayRow({ status: 'confirmed' })];
      if (hasOp(ops, 'where', (a) => a[0] && a[0].customer_id === 'c1') && hasOp(ops, 'whereIn', (a) => a[0] === 'scheduled_date')) return advanced;
      return [];
    } });
    const sibling = { technician_id: 'tech-1', scheduled_date: '2026-10-01', window_start: '09:00:00' };
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn: conn([sibling]) })).pastWindow).toBeNull();
    // another stop (different window) underway: this one still passed
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn: conn([{ ...sibling, window_start: '13:00:00' }]) })).pastWindow).toMatchObject({ visitId: 'visit-1' });
  });

  test('distinct visit groups, or rows that cannot be shown to share a stop, never collapse into one', async () => {
    const conn = (row, advanced) => fakeConn({ scheduled_services: (ops) => {
      if (isCandidateQuery(ops)) return [todayRow(row)];
      if (hasOp(ops, 'whereIn', (a) => a[0] === 'scheduled_date')) return advanced;
      return [];
    } });
    // same tech/day/window but a DIFFERENT visit group finished: still passed
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn: conn({ status: 'confirmed', visit_id: 'g1' }, [{ visit_id: 'g2', technician_id: 'tech-1', scheduled_date: '2026-10-01', window_start: '09:00:00' }]) })).pastWindow).toMatchObject({ visitId: 'visit-1' });
    // the SAME visit group finished: not passed
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn: conn({ status: 'confirmed', visit_id: 'g1' }, [{ visit_id: 'g1', technician_id: 'tech-1', scheduled_date: '2026-10-01', window_start: '09:00:00' }]) })).pastWindow).toBeNull();
    // a frozen group member reassigned to ANOTHER tech the same day keeps its visit_id but is a separate stop
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn: conn({ status: 'confirmed', visit_id: 'g1', technician_id: 'tech-2' }, [{ visit_id: 'g1', technician_id: 'tech-1', scheduled_date: '2026-10-01', window_start: '09:00:00' }]) })).pastWindow).toMatchObject({ visitId: 'visit-1' });
    // an unassigned row has no stop identity: an unassigned finished row never hides it
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn: conn({ status: 'confirmed', technician_id: null }, [{ technician_id: null, scheduled_date: '2026-10-01', window_start: '09:00:00' }]) })).pastWindow).toMatchObject({ visitId: 'visit-1' });
  });

  test('unassigned members of one visit share a stop (null-safe tech match): a finished sibling settles it', async () => {
    const conn = (started) => fakeConn({ scheduled_services: (ops) => (isCandidateQuery(ops)
      ? [todayRow({ status: 'confirmed', visit_id: 'g1', technician_id: null })] : started) });
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn: conn([{ visit_id: 'g1', technician_id: null, scheduled_date: '2026-10-01', status: 'completed' }]) })).pastWindow).toBeNull();
    // an assigned member of the same visit is another stop
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn: conn([{ visit_id: 'g1', technician_id: 'tech-1', scheduled_date: '2026-10-01', status: 'completed' }]) })).pastWindow).toMatchObject({ visitId: 'visit-1' });
  });

  test('passed visits with the same promised start sort by id (a stable signature)', async () => {
    const rows = [todayRow({ id: 'v-b', status: 'confirmed' }), todayRow({ id: 'v-a', status: 'confirmed' })];
    for (const order of [rows, [...rows].reverse()]) {
      const conn = fakeConn({ scheduled_services: (ops) => (isCandidateQuery(ops) ? order : []) });
      expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn })).pastWindow.passedKeys).toEqual(['v-a@2026-10-01T09:00:00', 'v-b@2026-10-01T09:00:00']);
    }
  });

  test('an uncleared street-level address hold is never "passed" (never dispatched)', async () => {
    const conn = (held) => fakeConn({ scheduled_services: (ops) => {
      if (isCandidateQuery(ops)) return [todayRow({ status: 'confirmed' })];
      if (hasOp(ops, 'whereExists')) return held;
      return [];
    } });
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn: conn([{ id: 'visit-1' }]) })).pastWindow).toBeNull();
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn: conn([]) })).pastWindow).toMatchObject({ visitId: 'visit-1' });
  });

  test('the PROMISED window counts, not the row\'s current schedule (an uncommunicated move)', async () => {
    // promised 9 AM today; staff moved the row to 3 PM without telling the customer: at noon it is passed
    loadPromiseEvents.mockResolvedValueOnce([{ visit_id: 'visit-1', start_at: '2026-10-01T13:00:00.000Z', communicated_at: '2026-09-29T12:00:00Z' }]);
    expect((await run({ status: 'confirmed', window_start: '15:00:00' })).pastWindow).toMatchObject({ visitId: 'visit-1', windowStart: '09:00:00', windowDisplay: '9:00 AM–11:00 AM' });
    // moved to NEXT week, promise still today: still found and passed
    loadPromiseEvents.mockResolvedValueOnce([{ visit_id: 'visit-1', start_at: '2026-10-01T13:00:00.000Z', communicated_at: '2026-09-29T12:00:00Z' }]);
    expect((await run({ status: 'confirmed', scheduled_date: '2026-10-08' })).pastWindow).toMatchObject({ scheduledDate: '2026-10-01' });
    // the customer was told 3 PM (a communicated move): not passed at noon
    loadPromiseEvents.mockResolvedValueOnce([{ visit_id: 'visit-1', start_at: '2026-10-01T19:00:00.000Z', communicated_at: '2026-10-01T12:00:00Z' }]);
    expect((await run({ status: 'confirmed', window_start: '09:00:00' })).pastWindow).toBeNull();
  });

  test('a grouped reminder stored on a SIBLING supersedes this member\'s older confirmation', async () => {
    const isSiblingQuery = (ops) => hasOp(ops, 'whereIn', (a) => a[0] === 'visit_id');
    let sibTech = 'tech-1';
    const conn = fakeConn({ scheduled_services: (ops) => {
      if (isCandidateQuery(ops)) return [todayRow({ visit_id: 'g1', status: 'confirmed' })];
      if (isSiblingQuery(ops)) return [{ id: 'visit-2', visit_id: 'g1', status: 'confirmed', technician_id: sibTech, scheduled_date: '2026-10-01' }];
      return [];
    } });
    // visit-1: 9 AM confirmation on 09-29; visit-2 carries the newer grouped 3 PM reminder for the whole stop
    loadPromiseEvents.mockResolvedValueOnce([
      { visit_id: 'visit-1', start_at: '2026-10-01T13:00:00.000Z', communicated_at: '2026-09-29T12:00:00Z' },
      { visit_id: 'visit-2', start_at: '2026-10-01T19:00:00.000Z', communicated_at: '2026-09-30T12:00:00Z', grouped: true },
    ]);
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn })).pastWindow).toBeNull();
    expect(loadPromiseEvents.mock.calls[0][1]).toEqual(['visit-1', 'visit-2']);
    // the sibling was reassigned to another tech: a separate physical stop, its notice never speaks for visit-1
    sibTech = 'tech-2';
    loadPromiseEvents.mockResolvedValueOnce([
      { visit_id: 'visit-1', start_at: '2026-10-01T13:00:00.000Z', communicated_at: '2026-09-29T12:00:00Z' },
    ]);
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn })).pastWindow).toMatchObject({ visitId: 'visit-1' });
  });

  test('a visit moved far out (no upper date bound) is still read; its promise decides the occurrence', async () => {
    const conn = fakeConn({ scheduled_services: (ops) => (isCandidateQuery(ops)
      ? [todayRow({ status: 'confirmed', scheduled_date: '2027-03-01' })] : []) });
    loadPromiseEvents.mockResolvedValueOnce([{ visit_id: 'visit-1', start_at: '2026-10-01T13:00:00.000Z', communicated_at: '2026-09-29T12:00:00Z' }]);
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn })).pastWindow).toMatchObject({ visitId: 'visit-1', scheduledDate: '2026-10-01' });
    // one customer's rows only, from 60 days back, no fleet-wide recall
    const scan = conn.calls.find((c) => c.table === 'scheduled_services' && isCandidateQuery(c.ops));
    expect(hasOp(scan.ops, 'where', (x) => x[0] && x[0].customer_id === 'c1')).toBe(true);
    expect(hasOp(scan.ops, 'where', (x) => x[0] === 'scheduled_date' && x[1] === '<=')).toBe(false);
    expect(promisedVisitIds).not.toHaveBeenCalled();
  });

  test('a cancelled claim owner\'s GROUPED reminder still holds a silently moved live sibling', async () => {
    const isSiblingQuery = (ops) => hasOp(ops, 'whereIn', (x) => x[0] === 'visit_id');
    const conn = fakeConn({ scheduled_services: (ops) => {
      if (isCandidateQuery(ops)) return [todayRow({ id: 'visit-b', visit_id: 'g1', status: 'confirmed', scheduled_date: '2026-12-15', window_start: '15:00:00' })];
      if (isSiblingQuery(ops)) return [{ id: 'visit-a', visit_id: 'g1', status: 'cancelled', technician_id: 'tech-1', scheduled_date: '2026-10-01' }];
      return [];
    } });
    loadPromiseEvents.mockResolvedValueOnce([{ visit_id: 'visit-a', start_at: '2026-10-01T13:00:00.000Z', communicated_at: '2026-09-29T12:00:00Z', grouped: true }]);
    expect((await loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn })).pastWindow).toMatchObject({ visitId: 'visit-b', scheduledDate: '2026-10-01', windowStart: '09:00:00' });
  });

  test('a promise whose window is UNKNOWN (a newer notice superseded it, start_at null) is never "passed"', async () => {
    // the schedule says 9 AM (passed at noon), but the customer's latest notice named no time we recorded
    loadPromiseEvents.mockResolvedValueOnce([{ visit_id: 'visit-1', start_at: null, communicated_at: '2026-10-01T11:00:00Z' }]);
    expect((await run({ status: 'confirmed', window_start: '09:00:00' })).pastWindow).toBeNull();
    // no promise event at all: the schedule is what booking showed them, so it still counts
    expect((await run({ status: 'confirmed', window_start: '09:00:00' })).pastWindow).toMatchObject({ visitId: 'visit-1' });
  });

  test('every passed visit rides in the signature keys; the earliest is rendered', async () => {
    const conn = fakeConn({ scheduled_services: (ops) => (isCandidateQuery(ops)
      ? [todayRow({ id: 'v-late', window_start: '10:00:00', status: 'confirmed' }), todayRow({ status: 'confirmed' })]
      : []) });
    const out = await loadVisitLoops({ customerId: 'c1', now: new Date('2026-10-01T17:00:00Z'), deriveWindow, conn }); // 13:00 ET
    expect(out.pastWindow).toMatchObject({ visitId: 'visit-1', passedKeys: ['visit-1@2026-10-01T09:00:00', 'v-late@2026-10-01T10:00:00'] });
  });

  test('an ordinary unfinished visit from YESTERDAY is not today\'s passed window; today\'s is', async () => {
    const conn = fakeConn({ scheduled_services: (ops) => (isCandidateQuery(ops)
      ? [todayRow({ id: 'v-yday', scheduled_date: '2026-09-30', status: 'confirmed' }), todayRow({ window_start: '10:00:00', status: 'confirmed' })]
      : []) });
    const out = await loadVisitLoops({ customerId: 'c1', now: new Date('2026-10-01T17:00:00Z'), deriveWindow, conn }); // 13:00 ET
    expect(out.pastWindow).toMatchObject({ visitId: 'visit-1', passedKeys: ['visit-1@2026-10-01T10:00:00'] });
    // yesterday's 23:00 window (ends 01:00 today) has passed by 13:00 today
    const late = fakeConn({ scheduled_services: (ops) => (isCandidateQuery(ops)
      ? [todayRow({ id: 'v-yday', scheduled_date: '2026-09-30', window_start: '23:00:00', status: 'confirmed' })] : []) });
    expect((await loadVisitLoops({ customerId: 'c1', now: new Date('2026-10-01T17:00:00Z'), deriveWindow, conn: late })).pastWindow).toMatchObject({ visitId: 'v-yday' });
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
    // every open Waves-owned call promise, paged from the canonical reader (it orders
    // oldest/overdue first; the facts show the newest five)
    expect(listOpenCommitments).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ customerId: 'c1', party: 'waves', limit: 200, offset: 0 }));
    // no resolved deadline: the spoken words, dated to the call
    expect(out.weOwe).toEqual([{ id: 'c-1', rev: expect.stringMatching(/^[0-9a-f]{12}$/), kind: 'send_estimate', description: 'Send the estimate', since: '2026-09-30', source: 'call' }]);
    expect(out.customerWaiting).toEqual([]);
    expect(out.weOwe).toHaveLength(1);
  });

  test('sms gate on: the request lane is the customer waiting, the promise lane is ours (classified by the query, no second read); each carries the day it was asked', async () => {
    smsCommitmentsEnabled.mockReturnValue(true);
    listSmsCommitments.mockImplementation(async (_c, { lane }) => (lane === 'promise'
      ? [smsRow({ id: 's-1' })]
      : [smsRow({ id: 's-2', kind: 'send_report', description: 'Report requested', due_at: null, sms_started_at: '2026-09-30T10:00:00Z' })]));
    // a failing sms_context read can no longer reclassify anything: it is never read
    const conn = fakeConn({ call_commitments: () => { throw new Error('context read down'); } });
    const out = await run(conn);
    expect(out.weOwe).toEqual([{ id: 's-1', rev: expect.any(String), kind: 'callback', description: 'Call back about ants', since: '2026-10-01', source: 'sms' }]);
    expect(out.customerWaiting).toEqual([{ id: 's-2', rev: expect.any(String), kind: 'send_report', description: 'Report requested', since: '2026-09-30' }]);
  });

  test('call promises are read to the end of the canonical reader\'s pages, so a new one behind 200 older ones still shows', async () => {
    const older = Array.from({ length: 200 }, (_, i) => callRow({ id: `old-${i}`, call_started_at: '2026-09-01T14:00:00Z' }));
    const fresh = callRow({ id: 'new-1', source: 'human', created_at: '2026-10-01T13:00:00Z' });
    listOpenCommitments.mockImplementation(async (_c, { offset }) => (offset === 0 ? older : [fresh]));
    const out = await run(ctxConn({}));
    expect(listOpenCommitments).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ offset: 200 }));
    expect(out.weOwe[0]).toMatchObject({ id: 'new-1' });
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

describe('missedVisit (logged customer no-shows)', () => {
  const noshow = (over = {}) => ({
    id: 'rl-1', scheduled_service_id: 'visit-1', original_date: '2026-09-29', original_window: '09:00:00-10:30:00', new_date: null,
    logged_at: new Date('2026-09-30T06:00:00Z'), occurrence_service_type: 'Pest Control', occurrence_service_id: null, occurrence_property_id: 'prop-1',
    ss_scheduled_date: '2026-09-29', window_start: '09:00:00', status: 'confirmed', track_state: null, recorded: false,
    ss_status_present: true, ss_service_id: null, ss_service_type: 'Pest Control', ss_property_id: 'prop-1', ...over,
  });
  const isFollowUpQuery = (ops) => hasOp(ops, 'where', (a) => a[0] && typeof a[0] === 'object' && 'property_id' in a[0]);
  // the catalog: rows matched by the lower(trim(name)) = ANY(names) read
  const CATALOG = [
    { id: 'svc-pest', name: 'Pest Control' }, { id: 'svc-lawn', name: 'Lawn Care' },
    { id: 'svc-flea', name: 'Flea Treatment' }, { id: 'svc-flea-pkg', name: 'Flea Treatment Package' },
    { id: 'svc-palm', name: 'Palm Injection' }, { id: 'svc-ts', name: 'Tree & Shrub Care' },
    { id: 'svc-dup-a', name: 'Inspection' }, { id: 'svc-dup-b', name: 'inspection ' },
  ];
  const run = (rows, later = [], catalog = CATALOG) => {
    const conn = fakeConn({
      reschedule_log: (ops) => (hasOp(ops, 'offset', (a) => a[0] === 0) ? [].concat(rows).slice(0, 10) : [].concat(rows).slice(10)),
      scheduled_services: (ops) => (isFollowUpQuery(ops) ? later : []),
      services: (ops) => {
        const names = ops.find((o) => o.op === 'whereRaw').args[1][0];
        return catalog.filter((c) => names.includes(c.name.trim().toLowerCase()));
      },
    });
    return loadVisitLoops({ customerId: 'c1', now: NOW, deriveWindow, conn }).then((out) => ({ out, conn }));
  };

  test('an open no-show renders its FROZEN scope and the window as promised', async () => {
    const { out, conn } = await run([noshow({ ss_scheduled_date: '2026-09-29' })]);
    expect(out.missedVisit).toEqual({ logId: 'rl-1', visitId: 'visit-1', type: 'Pest Control', date: '2026-09-29', windowStart: '09:00:00', windowDisplay: '9:00 AM–11:00 AM' });
    const q = conn.calls.find((c) => c.table === 'reschedule_log');
    // only logged customer no-shows with a frozen scope (pre-migration rows are unknown, never the live row's values)
    expect(hasOp(q.ops, 'where', (a) => a[0] === 'rl.reason_code' && a[1] === 'customer_noshow')).toBe(true);
    expect(hasOp(q.ops, 'whereNotNull', (a) => a[0] === 'rl.occurrence_service_type')).toBe(true);
    // the last 7 ET days
    expect(hasOp(q.ops, 'where', (a) => a[0] === 'rl.original_date' && a[1] === '>=' && a[2] === '2026-09-24')).toBe(true);
  });

  test('followed up through the logged row itself: rebooked in place, moved off the slot, completed or performed', async () => {
    for (const over of [{ new_date: '2026-10-03' }, { ss_scheduled_date: '2026-10-06' }, { window_start: '13:00:00' },
      { status: 'completed' }, { track_state: 'complete' }, { recorded: true }]) {
      expect((await run([noshow(over)])).out.missedVisit).toBeNull();
    }
    // a cancelled row that was not moved is not a follow-up
    expect((await run([noshow({ status: 'cancelled' })])).out.missedVisit).toMatchObject({ logId: 'rl-1' });
  });

  test('a live logged row: another booking is never follow-up evidence (series top-ups, call bookings)', async () => {
    const later = { service_id: null, service_type: 'Pest Control', scheduled_date: '2026-10-03', window_start: '09:00:00', status: 'confirmed' };
    const { out, conn } = await run([noshow()], [later]);
    expect(out.missedVisit).toMatchObject({ logId: 'rl-1' });
    expect(conn.calls.some((c) => c.table === 'scheduled_services' && isFollowUpQuery(c.ops))).toBe(false);
  });

  test('a TERMINAL logged row (dispatch no-show, skipped, cancelled, gone): an office-booked replacement clears it (owner 10-02, Codex #5610 r4)', async () => {
    const repl = (over = {}) => ({ service_id: null, service_type: 'Pest Control', status: 'confirmed', source_action: null, customer_confirmed: null, ...over });
    for (const terminal of [{ status: 'no_show' }, { status: 'skipped' }, { status: 'cancelled' }, { status: 'rescheduled' }, { status: 'some_future_parking_status' }, { ss_status_present: false, status: null }]) {
      expect((await run([noshow(terminal)], [repl()])).out.missedVisit).toBeNull();
      // no replacement: still open
      expect((await run([noshow(terminal)], [])).out.missedVisit).toMatchObject({ logId: 'rl-1' });
    }
    const { conn } = await run([noshow({ status: 'no_show' })], [repl()]);
    const q = conn.calls.find((c) => c.table === 'scheduled_services' && isFollowUpQuery(c.ops));
    // same customer + frozen property, booked after the log, on/after the missed day, never a series child or the row itself
    expect(hasOp(q.ops, 'where', (a) => a[0].property_id === 'prop-1')).toBe(true);
    expect(hasOp(q.ops, 'where', (a) => a[0].customer_id === 'c1')).toBe(true);
    expect(hasOp(q.ops, 'where', (a) => a[0] === 'created_at' && a[1] === '>' && a[2] instanceof Date)).toBe(true);
    expect(hasOp(q.ops, 'where', (a) => a[0] === 'scheduled_date' && a[1] === '>=' && a[2] === '2026-09-29')).toBe(true);
    expect(hasOp(q.ops, 'whereNull', (a) => a[0] === 'recurring_parent_id')).toBe(true);
    expect(hasOp(q.ops, 'whereNot', (a) => a[0] === 'id' && a[1] === 'visit-1')).toBe(true);
    // another catalog service, or an unreviewed call / voice booking, is no replacement
    expect((await run([noshow({ status: 'no_show' })], [repl({ service_type: 'Lawn Care' })])).out.missedVisit).toMatchObject({ logId: 'rl-1' });
    expect((await run([noshow({ status: 'no_show' })], [repl({ status: 'pending', source_action: 'ai_call_outbound_review', customer_confirmed: false })])).out.missedVisit).toMatchObject({ logId: 'rl-1' });
    expect((await run([noshow({ status: 'no_show' })], [repl({ source_action: 'voice_agent', customer_confirmed: false })])).out.missedVisit).toMatchObject({ logId: 'rl-1' });
    // Codex #5610 r7: a visit generated from ANOTHER visit, or tracker-cancelled, is no replacement;
    // one generated from the missed row itself is explicit provenance and counts
    const miss = noshow({ status: 'no_show' });
    expect((await run([miss], [repl({ followup_source_service_id: 'visit-other' })])).out.missedVisit).toMatchObject({ logId: 'rl-1' });
    expect((await run([miss], [repl({ parent_service_id: 'visit-other' })])).out.missedVisit).toMatchObject({ logId: 'rl-1' });
    expect((await run([miss], [repl({ parent_service_id: 'visit-1' })])).out.missedVisit).toBeNull();
    expect((await run([miss], [repl({ track_state: 'cancelled' })])).out.missedVisit).toMatchObject({ logId: 'rl-1' });
    expect((await run([miss], [repl({ track_state: 'scheduled' })])).out.missedVisit).toBeNull();
  });

  test('a move the office has not reviewed (call-booked / voice-agent) is not a rebooking', async () => {
    for (const over of [
      { new_date: '2026-10-03', status: 'pending', ss_source_action: 'ai_call_outbound_review', ss_customer_confirmed: false },
      { new_date: '2026-10-03', status: 'confirmed', ss_source_action: 'voice_agent', ss_customer_confirmed: false },
    ]) {
      expect((await run([noshow(over)])).out.missedVisit).toMatchObject({ logId: 'rl-1' });
      expect((await run([noshow({ ...over, ss_customer_confirmed: true })])).out.missedVisit).toBeNull();
    }
  });

  test('the logged row is follow-up evidence only while it holds the frozen scope (pre-push audit P1, #5610 r2)', async () => {
    // moved / completed, but repurposed for another address or another service: the miss stays open
    for (const over of [{ ss_property_id: 'prop-2' }, { ss_property_id: null }, { ss_service_type: 'Lawn Care' }, { ss_service_id: 'svc-lawn' }]) {
      expect((await run([noshow({ new_date: '2026-10-03', ...over })])).out.missedVisit).toMatchObject({ logId: 'rl-1' });
      expect((await run([noshow({ status: 'completed', ...over })])).out.missedVisit).toMatchObject({ logId: 'rl-1' });
    }
    // the same catalog service under a renamed label still counts
    expect((await run([noshow({ new_date: '2026-10-03', occurrence_service_id: 'svc-pest', ss_service_id: 'svc-pest', ss_service_type: 'General Pest' })])).out.missedVisit).toBeNull();
    // the row is gone: no same-row evidence
    expect((await run([noshow({ ss_status_present: false, status: null, track_state: null, ss_scheduled_date: null })])).out.missedVisit).toMatchObject({ logId: 'rl-1' });
  });

  test('the visit itself under way (tech started it late, unmoved) resolves the hand-off; a windowless slot given a time is a move (Codex #5610 r3)', async () => {
    for (const over of [{ status: 'en_route' }, { status: 'on_site' }, { track_state: 'en_route' }, { track_state: 'on_property' }]) {
      expect((await run([noshow(over)])).out.missedVisit).toBeNull();
    }
    // still unstarted at the same slot: open
    expect((await run([noshow({ track_state: 'scheduled' })])).out.missedVisit).toMatchObject({ logId: 'rl-1' });
    // windowless miss: same day, still windowless = open; given a time = moved
    expect((await run([noshow({ original_window: null, window_start: null })])).out.missedVisit).toMatchObject({ logId: 'rl-1' });
    expect((await run([noshow({ original_window: null, window_start: '14:00:00' })])).out.missedVisit).toBeNull();
  });

  test('a page of followed-up misses never hides an older open one', async () => {
    const done = Array.from({ length: 10 }, (_, i) => noshow({ id: `rl-d${i}`, new_date: '2026-10-03' }));
    const { out } = await run([...done, noshow({ id: 'rl-old', original_date: '2026-09-25', ss_scheduled_date: '2026-09-25' })]);
    expect(out.missedVisit).toMatchObject({ logId: 'rl-old', date: '2026-09-25' });
  });

  test('same row, same service = the catalog identity (service_id, else the one catalog row by exact name), never a keyword family (Codex #5610 r1 P1)', async () => {
    const open = async (over) => (await run([noshow({ new_date: '2026-10-03', ...over })])).out.missedVisit;
    expect(await open({ occurrence_service_id: 'svc-pest', ss_service_id: 'svc-pest', ss_service_type: 'General Pest (renamed)' })).toBeNull();
    expect(await open({ occurrence_service_id: 'svc-pest', ss_service_type: ' pest control ' })).toBeNull();
    expect(await open({ occurrence_service_type: 'Flea Treatment', ss_service_type: 'Flea Treatment Package' })).toMatchObject({ logId: 'rl-1' });
    expect(await open({ occurrence_service_type: 'Palm Injection', ss_service_type: 'Tree & Shrub Care' })).toMatchObject({ logId: 'rl-1' });
    expect(await open({ occurrence_service_type: 'Wasp Nest Removal', ss_service_type: 'wasp nest removal' })).toBeNull();
    expect(await open({ occurrence_service_type: 'Inspection', ss_service_type: 'INSPECTION' })).toBeNull();
    expect(await open({ occurrence_service_type: 'Inspection', ss_service_id: 'svc-dup-a', ss_service_type: 'Inspection' })).toMatchObject({ logId: 'rl-1' });
  });

  test('the logged miss supersedes WINDOW PASSED for the SAME visit (nightly sweep evening), not for another (Codex #5610 r4)', async () => {
    const todayMiss = noshow({ original_date: '2026-10-01', ss_scheduled_date: '2026-10-01', status: 'pending' });
    const load = (rows, pastRow) => loadVisitLoops({
      customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, deriveWindow,
      conn: fakeConn({
        reschedule_log: () => rows,
        services: () => CATALOG.filter((c) => c.name === 'Pest Control'),
        scheduled_services: (ops, kind) => (isCandidateQuery(ops) ? [todayRow(pastRow)] : (kind === 'first' ? null : [])),
      }),
    });
    const same = await load([todayMiss], { status: 'pending' });
    expect(same.missedVisit).toMatchObject({ logId: 'rl-1', visitId: 'visit-1' });
    expect(same.pastWindow).toBeNull();
    // a passed window on ANOTHER visit stays
    const other = await load([todayMiss], { id: 'visit-2', status: 'pending' });
    expect(other.missedVisit).toMatchObject({ visitId: 'visit-1' });
    expect(other.pastWindow).toMatchObject({ visitId: 'visit-2' });
  });

  test('the signature names the logged occurrence', async () => {
    const { visitStatusSignature } = require('../services/visit-loops-facts');
    const m = { logId: 'rl-1', type: 'Pest Control', date: '2026-09-29', windowStart: '09:00:00' };
    expect(visitStatusSignature({ missedVisit: m })).toBe('missed:rl-1:Pest Control:2026-09-29@09:00:00');
    expect(visitStatusSignature({ missedVisit: { ...m, logId: 'rl-2' } })).not.toBe(visitStatusSignature({ missedVisit: m }));
  });
});
