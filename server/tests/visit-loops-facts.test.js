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
jest.mock('../services/no-show-detector', () => ({
  loadPromiseEvents: jest.fn(async () => []),
  latestPromises: (events) => new Map((events || []).map((e) => [String(e.visit_id), e])),
}));
const { loadPromiseEvents } = require('../services/no-show-detector');

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
    const stub = { whereIn: (...a) => { got.push(a); return stub; }, orWhereIn: (...a) => { got.push(a); return stub; } };
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

  test('yesterday\'s 23:00 occurrence stays live until its window ends at 01:00 ET', async () => {
    const row = alertRow({ payload: { scheduled_date: '2026-09-30', window_start: '23:00:00' } }, { scheduled_date: '2026-09-30', window_start: '23:00:00' });
    expect((await run(row, new Date('2026-10-01T04:30:00Z'))).lateAlert).toMatchObject({ visitId: 'visit-1' }); // 00:30 ET
    expect((await run(row, new Date('2026-10-01T05:30:00Z'))).lateAlert).toBeNull(); // 01:30 ET
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
    expect(out.pastWindow).toEqual({ visitId: 'visit-1', windowStart: '09:00:00', scheduledDate: '2026-10-01', type: 'Pest Control', windowDisplay: '9:00 AM–11:00 AM', minutesPast: 60, passedKeys: ['visit-1@2026-10-01T09:00:00'] });
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
