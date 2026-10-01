/**
 * visit-loops-facts: the read-only "visit status and open loops" facts
 * (tech position, late alert, passed window, missed visit, live note, promises
 * we owe, asks still waiting). Mocked db; no network. Synthetic data only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/call-commitments', () => ({ listOpenCommitments: jest.fn() }));
jest.mock('../services/sms-operational-actions', () => ({ smsCommitmentsEnabled: jest.fn(), listSmsCommitments: jest.fn() }));

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
  return conn;
}
const hasOp = (ops, op, pred) => ops.some((o) => o.op === op && (!pred || pred(o.args)));

const todayEntry = (over = {}) => ({ type: 'Pest Control', date: '2026-10-01', isToday: true, tech: 'Jamie Rivera', scheduledServiceId: 'visit-1', ...over });
const todayRow = (over = {}) => ({
  id: 'visit-1', technician_id: 'tech-1', route_order: 3, scheduled_date: '2026-10-01', status: 'confirmed', track_state: null,
  window_start: '09:00:00', window_end: '10:00:00', window_display: null, time_window: null, service_type: 'Pest Control',
  notes: null, updated_at: minutesAgo(30), ...over,
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
      if (hasOp(ops, 'whereIn', (a) => a[0] === 'id')) return [todayRow(extra.visit)];
      if (hasOp(ops, 'count')) return { count: extra.ahead ?? '2' };
      return kind === 'first' ? null : [];
    },
    tech_status: () => ('status' in extra ? extra.status : { status: 'en_route', current_job_id: 'other', location_updated_at: minutesAgo(2) }),
  });

  test('fresh position: status, minutes, stops ahead (terminal/rescheduled excluded in SQL), first name only', async () => {
    const conn = fakeConn(handlers());
    const out = await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, conn, deriveWindow });
    expect(out.techPosition).toEqual({ techName: 'Jamie', status: 'en_route', minutesSinceUpdate: 2, stopsAhead: 2, atThisVisit: false });
    const count = conn.calls.find((c) => c.table === 'scheduled_services' && hasOp(c.ops, 'count'));
    expect(hasOp(count.ops, 'whereNotIn', (a) => a[0] === 'status' && ['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled'].every((s) => a[1].includes(s)))).toBe(true);
    expect(hasOp(count.ops, 'where', (a) => a[0] === 'route_order' && a[1] === '<' && a[2] === 3)).toBe(true);
  });

  test('atThisVisit when the tech status points at this visit', async () => {
    const conn = fakeConn(handlers({ status: { status: 'on_site', current_job_id: 'visit-1', location_updated_at: minutesAgo(1) } }));
    const out = await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, conn });
    expect(out.techPosition).toMatchObject({ status: 'on_site', atThisVisit: true });
  });

  test('a location older than five minutes reads stale but keeps the age', async () => {
    const conn = fakeConn(handlers({ status: { status: 'en_route', current_job_id: null, location_updated_at: minutesAgo(9) } }));
    const out = await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, conn });
    expect(out.techPosition).toMatchObject({ status: 'stale', minutesSinceUpdate: 9, atThisVisit: false });
  });

  test('no tech_status row: stale with unknown age', async () => {
    const conn = fakeConn(handlers({ status: null }));
    const out = await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, conn });
    expect(out.techPosition).toMatchObject({ status: 'stale', minutesSinceUpdate: null, atThisVisit: false });
  });

  test('unknown route_order: stopsAhead null and no count query', async () => {
    const conn = fakeConn(handlers({ visit: { route_order: null } }));
    const out = await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, conn });
    expect(out.techPosition.stopsAhead).toBeNull();
    expect(conn.calls.some((c) => c.table === 'scheduled_services' && hasOp(c.ops, 'count'))).toBe(false);
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
    customerId: 'c1', upcomingServices: [todayEntry()], now: NOW,
    conn: fakeConn({
      scheduled_services: (ops, kind) => (hasOp(ops, 'whereIn') ? [todayRow({ status: 'en_route' })] : (kind === 'first' ? null : [])),
      dispatch_alerts: () => alert,
    }),
  });

  test('an open alert carries type, severity and minutes from the payload (string or object)', async () => {
    expect((await run({ type: 'tech_late', severity: 'warn', payload: JSON.stringify({ delay_minutes: 35 }) })).lateAlert)
      .toEqual({ type: 'tech_late', severity: 'warn', minutesLate: 35, missingTracking: false });
    expect((await run({ type: 'unassigned_overdue', severity: 'critical', payload: { delay_minutes: '12' } })).lateAlert)
      .toEqual({ type: 'unassigned_overdue', severity: 'critical', minutesLate: 12, missingTracking: false });
  });

  test('a no-show-detector missing-tracking alert is a tracking gap, not lateness', async () => {
    const payload = { source: 'no_show_detector', evidence: 'missing_tracking', stage: 1, delay_minutes: 50 };
    expect((await run({ type: 'tech_late', severity: 'warn', payload })).lateAlert)
      .toEqual({ type: 'tech_late', severity: 'warn', minutesLate: null, missingTracking: true });
  });

  test('no minutes in the payload: minutesLate null; no open alert: null', async () => {
    expect((await run({ type: 'tech_late', severity: 'info', payload: null })).lateAlert.minutesLate).toBeNull();
    expect((await run(null)).lateAlert).toBeNull();
  });

  test('queries only unresolved alerts of the two overdue types for today\'s visit ids', async () => {
    const conn = fakeConn({
      scheduled_services: (ops) => (hasOp(ops, 'whereIn') ? [todayRow()] : null),
      dispatch_alerts: () => null,
    });
    await loadVisitLoops({ customerId: 'c1', upcomingServices: [todayEntry()], now: NOW, conn });
    const q = conn.calls.find((c) => c.table === 'dispatch_alerts');
    expect(hasOp(q.ops, 'whereNull', (a) => a[0] === 'resolved_at')).toBe(true);
    expect(hasOp(q.ops, 'whereIn', (a) => a[0] === 'type' && a[1].join() === 'tech_late,unassigned_overdue')).toBe(true);
    expect(hasOp(q.ops, 'whereIn', (a) => a[0] === 'job_id' && a[1].join() === 'visit-1')).toBe(true);
  });
});

describe('pastWindow and liveNote', () => {
  const run = (row, now = NOW) => loadVisitLoops({
    customerId: 'c1', upcomingServices: [todayEntry()], now, deriveWindow,
    conn: fakeConn({ scheduled_services: (ops, kind) => (hasOp(ops, 'whereIn') ? [todayRow(row)] : (kind === 'first' ? null : [])) }),
  });

  test('a pending visit past its customer-facing window (start + 2h, not the internal block) reads passed', async () => {
    // window_start 09:00, internal window_end 10:00, customer window 9-11; it is 12:00.
    const out = await run({ status: 'pending' });
    expect(out.pastWindow).toEqual({ type: 'Pest Control', windowDisplay: '9:00 AM–11:00 AM', minutesPast: 60 });
  });

  test('inside the customer-facing window (even past the internal window_end) is not passed', async () => {
    const out = await run({ status: 'confirmed' }, new Date('2026-10-01T14:30:00Z')); // 10:30 ET
    expect(out.pastWindow).toBeNull();
  });

  test('a started visit, or one whose tracker is live, is never "passed"', async () => {
    expect((await run({ status: 'on_site' })).pastWindow).toBeNull();
    expect((await run({ status: 'pending', track_state: 'en_route' })).pastWindow).toBeNull();
  });

  test('no start time: falls back to window_end', async () => {
    const out = await run({ status: 'pending', window_start: null, window_end: '11:30:00' });
    expect(out.pastWindow).toMatchObject({ minutesPast: 30 });
  });

  test('liveNote: raw text trimmed to 240 chars for an en-route visit, with its timestamp', async () => {
    const out = await run({ status: 'en_route', notes: `  ${'x'.repeat(300)}  `, updated_at: minutesAgo(5) });
    expect(out.liveNote.text).toHaveLength(240);
    expect(out.liveNote.updatedAt).toBe(minutesAgo(5).toISOString());
  });

  test('liveNote also rides a passed-window visit; a pending future visit\'s booking note is not a live note', async () => {
    expect((await run({ status: 'pending', notes: 'running behind, parts run' })).liveNote.text).toBe('running behind, parts run');
    expect((await run({ status: 'confirmed', notes: 'gate side door' }, new Date('2026-10-01T12:00:00Z'))).liveNote).toBeNull();
  });

  test('empty note: null', async () => {
    expect((await run({ status: 'en_route', notes: '   ' })).liveNote).toBeNull();
  });
});

describe('missedVisit', () => {
  const run = ({ unfinished = null, noshow = null, later = [] }) => loadVisitLoops({
    customerId: 'c1', upcomingServices: [], now: NOW, deriveWindow,
    conn: fakeConn({
      scheduled_services: (ops, kind) => (kind === 'first' ? unfinished : later),
      reschedule_log: () => noshow,
    }),
  });

  test('a pending visit from the last week reads as not completed', async () => {
    const out = await run({ unfinished: { id: 'v0', service_type: 'Lawn Care', scheduled_date: '2026-09-29', window_start: '09:00:00', status: 'confirmed' } });
    expect(out.missedVisit).toEqual({ type: 'Lawn Care', date: '2026-09-29', windowDisplay: '9:00 AM–11:00 AM', status: 'confirmed', reason: 'not_completed' });
  });

  test('queries the last 7 ET days, before today, pending/confirmed only', async () => {
    const conn = fakeConn({ scheduled_services: () => null, reschedule_log: () => null });
    await loadVisitLoops({ customerId: 'c1', upcomingServices: [], now: NOW, conn });
    const q = conn.calls.find((c) => c.table === 'scheduled_services');
    expect(hasOp(q.ops, 'where', (a) => a[0] === 'scheduled_date' && a[1] === '<' && a[2] === '2026-10-01')).toBe(true);
    expect(hasOp(q.ops, 'where', (a) => a[0] === 'scheduled_date' && a[1] === '>=' && a[2] === '2026-09-24')).toBe(true);
    expect(hasOp(q.ops, 'whereIn', (a) => a[0] === 'status' && a[1].join() === 'pending,confirmed')).toBe(true);
  });

  test('a customer no-show not followed by a later visit of the same service counts', async () => {
    const out = await run({ noshow: { original_date: '2026-09-30', service_type: 'Mosquito Control', window_start: '13:00:00', status: 'no_show' } });
    expect(out.missedVisit).toMatchObject({ type: 'Mosquito Control', date: '2026-09-30', reason: 'customer_noshow', status: 'no_show' });
  });

  test('a no-show already followed by a later visit of the same family is not missed; another family does not cancel it', async () => {
    const noshow = { original_date: '2026-09-30', service_type: 'Mosquito Control', window_start: null, status: 'no_show' };
    expect((await run({ noshow, later: [{ service_type: 'Mosquito Barrier Spray' }] })).missedVisit).toBeNull();
    expect((await run({ noshow, later: [{ service_type: 'Lawn Care' }] })).missedVisit).toMatchObject({ reason: 'customer_noshow' });
  });

  test('both present: the most recent date wins', async () => {
    const out = await run({
      unfinished: { id: 'v0', service_type: 'Lawn Care', scheduled_date: '2026-09-26', status: 'pending' },
      noshow: { original_date: '2026-09-30', service_type: 'Pest Control', status: 'no_show' },
    });
    expect(out.missedVisit).toMatchObject({ date: '2026-09-30', reason: 'customer_noshow' });
  });

  test('familyKey buckets', () => {
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

  test('both gates off: neither reader is called', async () => {
    const out = await run(ctxConn({}));
    expect(out.weOwe).toEqual([]);
    expect(out.customerWaiting).toEqual([]);
    expect(listOpenCommitments).not.toHaveBeenCalled();
    expect(listSmsCommitments).not.toHaveBeenCalled();
  });

  test('call gate on: waves-party call promises become weOwe; customer-party call rows appear nowhere', async () => {
    featureGates.gates.callCommitments = true;
    listOpenCommitments.mockResolvedValue([
      callRow({}),
      callRow({ id: 'c-2', party: 'customer', kind: 'send_photos', description: 'Send photos of the fence', call_started_at: '2026-09-29T14:00:00Z' }),
    ]);
    const out = await run(ctxConn({}));
    expect(listOpenCommitments).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ customerId: 'c1', limit: 50 }));
    expect(out.weOwe).toEqual([{ kind: 'send_estimate', description: 'Send the estimate', dueText: 'by tomorrow', source: 'call' }]);
    expect(out.customerWaiting).toEqual([]);
    expect(out.weOwe).toHaveLength(1);
  });

  test('sms gate on: basis request is the customer waiting, basis promise is ours; due text from sms_context, else ET stamp', async () => {
    smsCommitmentsEnabled.mockReturnValue(true);
    listSmsCommitments.mockResolvedValue([
      smsRow({ id: 's-1' }),
      smsRow({ id: 's-2', kind: 'send_report', description: 'Report requested', due_at: null, sms_started_at: '2026-09-30T10:00:00Z' }),
    ]);
    const out = await run(ctxConn({ 's-1': { basis: 'promise', due_text: 'later today' }, 's-2': { basis: 'request' } }));
    expect(out.weOwe).toEqual([{ kind: 'callback', description: 'Call back about ants', dueText: 'later today', source: 'sms' }]);
    expect(out.customerWaiting).toEqual([{ kind: 'send_report', description: 'Report requested', since: '2026-09-30' }]);
    // no spoken due text: the due instant, formatted in ET
    const noText = await run(ctxConn({ 's-1': { basis: 'promise' } }));
    expect(noText.weOwe[0].dueText).toBe('Thu, Oct 1, 5:00 PM');
  });

  test('email rows need their own gate; sms off + email on keeps only email rows', async () => {
    process.env.GATE_EMAIL_OPERATIONAL_ACTIONS = 'true';
    listSmsCommitments.mockResolvedValue([smsRow({ id: 's-1' }), smsRow({ id: 'e-1', channel: 'email', description: 'Send the quote' })]);
    const out = await run(ctxConn({ 'e-1': { basis: 'promise' } }));
    expect(out.weOwe).toEqual([expect.objectContaining({ description: 'Send the quote', source: 'email' })]);
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
