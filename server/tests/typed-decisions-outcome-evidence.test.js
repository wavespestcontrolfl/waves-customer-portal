// Outcome evidence: what the database recorded AFTER a call or text. null =
// unknown (missing linkage or window not elapsed), never a negative.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
const { LOGGED_MOVE_SQL } = require('../utils/reschedule-log-sql');
const mockCallEndFor = jest.fn();
const mockResolveLead = jest.fn();
jest.mock('../services/call-booking-link-text', () => ({
  callEndFor: (...a) => mockCallEndFor(...a),
  resolveLeadLinkage: (...a) => mockResolveLead(...a),
}));

const { callEvidence, smsEvidence, refreshOutcomeEvidence } = require('../services/typed-decisions/outcome-evidence');

const HOUR = 3600 * 1000;
const NOW = new Date('2026-10-01T15:00:00.000Z');
const ago = (hours) => new Date(NOW.getTime() - hours * HOUR);

// A chainable stand-in for knex: every builder method returns the builder,
// `first` pops the next queued answer for the table (the JOINED table when a
// join was added), and awaiting it yields the table's list.
function fakeConn({ first = {}, lists = {} } = {}) {
  const log = [];
  const conn = (name) => {
    const table = String(name).split(' as ')[0];
    const state = { table, joined: null, calls: [] };
    log.push(state);
    const b = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'then') return (res, rej) => Promise.resolve(lists[table] || []).then(res, rej);
        if (prop === 'first') {
          return async (...cols) => {
            const key = state.joined || table;
            state.calls.push(['first', cols]);
            const queue = first[key];
            return Array.isArray(queue) ? queue.shift() : queue;
          };
        }
        return (...args) => {
          state.calls.push([prop, args]);
          if (prop === 'join') state.joined = String(args[0]).split(' as ')[0];
          return b;
        };
      },
    });
    return b;
  };
  conn.log = log;
  return conn;
}

const call = (over = {}) => ({
  id: 'call-1', direction: 'inbound', from_phone: '+19415550100', to_phone: '+19415550199', customer_id: 'cust-1',
  twilio_call_sid: 'CA1', created_at: ago(1), duration_seconds: 60, metadata: {}, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveLead.mockResolvedValue({ leadId: null, ambiguous: false });
});

describe('callEvidence', () => {
  test('a call that ended minutes ago has no negatives yet: every window is open', async () => {
    mockCallEndFor.mockReturnValue(ago(0.5));
    const out = await callEvidence(call(), { now: NOW, conn: fakeConn() });
    expect(out.appointment_agreed).toMatchObject({ source: 'scheduled_services', window: '24h', value: null });
    expect(out.quote_promised).toMatchObject({ source: 'estimates', window: '48h', value: null });
    expect(out.is_lead).toMatchObject({ source: 'leads_customers', window: '7d', value: null });
    expect(out.appointment_agreed.observed_at).toBe(NOW.toISOString());
  });

  test('a booking created inside the window is final at once (true), even before the window closes', async () => {
    mockCallEndFor.mockReturnValue(ago(0.5));
    const out = await callEvidence(call(), { now: NOW, conn: fakeConn({ first: { scheduled_services: [{ id: 'visit-1' }] } }) });
    expect(out.appointment_agreed.value).toBe(true);
  });

  test('bookings and quotes count from the call START (booked while still on the line)', async () => {
    mockCallEndFor.mockReturnValue(ago(5));
    const c = call({ created_at: ago(5.5) });
    const conn = fakeConn();
    await callEvidence(c, { now: NOW, conn });
    const visits = conn.log.find((q) => q.table === 'scheduled_services');
    const lowerBound = visits.calls.find(([m, a]) => m === 'where' && a[0] === 's.created_at' && a[1] === '>=');
    expect(lowerBound[1][2].getTime()).toBeLessThan(ago(5).getTime());
    const estimates = conn.log.find((q) => q.table === 'estimates');
    expect(estimates.calls.find(([m, a]) => m === 'where' && a[0] === 'sent_at' && a[1] === '>=')[1][2].getTime()).toBeLessThan(ago(5).getTime());
  });

  test('a move filed in reschedule_log (no status row) also counts', async () => {
    mockCallEndFor.mockReturnValue(ago(5));
    const out = await callEvidence(call(), { now: NOW, conn: fakeConn({ first: { scheduled_services: [undefined], job_status_history: [undefined], reschedule_log: [{ id: 'r1' }] } }) });
    expect(out.appointment_agreed.value).toBe(true);
  });

  test('reschedule_log counts only real moves (a no-show or a same-slot bulk reschedule is not one)', async () => {
    mockCallEndFor.mockReturnValue(ago(5));
    const conn = fakeConn({ first: { scheduled_services: [undefined], job_status_history: [undefined], reschedule_log: [undefined] } });
    await callEvidence(call(), { now: NOW, conn });
    await smsEvidence({ id: 'sms-1', customer_id: 'cust-1', created_at: ago(30) }, { now: NOW, conn });
    const logs = conn.log.filter((q) => q.table === 'reschedule_log');
    expect(logs.length).toBe(2);
    // the fulfillment checker's real-move predicate: a changed date or window
    for (const q of logs) expect(q.calls).toContainEqual(['whereRaw', [LOGGED_MOVE_SQL('r')]]);
    // the text's move must be of a visit that already existed and was upcoming
    expect(logs[1].calls).toContainEqual(['join', ['scheduled_services as s', 's.id', 'r.scheduled_service_id']]);
    expect(logs[1].calls).toContainEqual(['where', ['s.created_at', '<=', ago(30)]]);
    expect(logs[0].calls.some(([m]) => m === 'join')).toBe(false); // a call's agreed move may be any visit
  });

  test('a visit RESCHEDULED in the window counts when nothing was created', async () => {
    mockCallEndFor.mockReturnValue(ago(5));
    const out = await callEvidence(call(), { now: NOW, conn: fakeConn({ first: { scheduled_services: [undefined], job_status_history: [{ id: 'h1' }] } }) });
    expect(out.appointment_agreed.value).toBe(true);
  });

  test('absence is false only once the window has elapsed', async () => {
    mockCallEndFor.mockReturnValue(ago(72)); // 24h and 48h are over, 7d is not
    const out = await callEvidence(call(), { now: NOW, conn: fakeConn() });
    expect(out.appointment_agreed.value).toBe(false);
    expect(out.quote_promised.value).toBe(false);
    expect(out.is_lead.value).toBeNull();
    mockCallEndFor.mockReturnValue(ago(24 * 8));
    expect((await callEvidence(call(), { now: NOW, conn: fakeConn() })).is_lead.value).toBe(false);
  });

  test('a sent estimate within 48h is true; the query reads sent estimates only', async () => {
    mockCallEndFor.mockReturnValue(ago(10));
    const conn = fakeConn({ first: { estimates: [{ id: 'est-1' }] } });
    const out = await callEvidence(call(), { now: NOW, conn });
    expect(out.quote_promised.value).toBe(true);
    const q = conn.log.find((s) => s.table === 'estimates');
    expect(q.calls.some(([m, a]) => m === 'whereNotNull' && a[0] === 'sent_at')).toBe(true);
  });

  test('a lead row created from the call counts as is_lead', async () => {
    mockCallEndFor.mockReturnValue(ago(2));
    const out = await callEvidence(call(), { now: NOW, conn: fakeConn({ first: { leads: [{ id: 'lead-1' }] } }) });
    expect(out.is_lead.value).toBe(true);
  });

  test('a customers row created from the phone also counts when no lead exists', async () => {
    mockCallEndFor.mockReturnValue(ago(2));
    const out = await callEvidence(call(), { now: NOW, conn: fakeConn({ first: { leads: [undefined], customers: [{ id: 'cust-9' }] } }) });
    expect(out.is_lead.value).toBe(true);
  });

  test('no customer and no lead behind the call: unknown even after every window (missing linkage is not a negative)', async () => {
    mockCallEndFor.mockReturnValue(ago(24 * 9));
    const out = await callEvidence(call({ customer_id: null }), { now: NOW, conn: fakeConn({ lists: { customers: [] } }) });
    expect(out.appointment_agreed.value).toBeNull();
    expect(out.quote_promised.value).toBeNull();
  });

  test('a customer found on the number (one match) supplies the linkage; two matches do not', async () => {
    mockCallEndFor.mockReturnValue(ago(30));
    const one = await callEvidence(call({ customer_id: null }), { now: NOW, conn: fakeConn({ lists: { customers: [{ id: 'c-1' }] } }) });
    expect(one.appointment_agreed.value).toBe(false);
    const two = await callEvidence(call({ customer_id: null }), { now: NOW, conn: fakeConn({ lists: { customers: [{ id: 'c-1' }, { id: 'c-2' }] } }) });
    expect(two.appointment_agreed.value).toBeNull();
  });

  test('a lead stamped on the call supplies the customer and the estimate link', async () => {
    mockCallEndFor.mockReturnValue(ago(60));
    mockResolveLead.mockResolvedValue({ leadId: 'lead-7', ambiguous: false });
    const conn = fakeConn({ first: { leads: [{ id: 'lead-7', customer_id: 'cust-7', estimate_id: 'est-7' }] } });
    const out = await callEvidence(call({ customer_id: null }), { now: NOW, conn });
    expect(out.appointment_agreed.value).toBe(false);
    expect(out.quote_promised.value).toBe(false);
  });

  test('a call with no readable end is unknown on every question', async () => {
    mockCallEndFor.mockReturnValue(null);
    const out = await callEvidence(call(), { now: NOW, conn: fakeConn() });
    expect(Object.values(out).map((e) => e.value)).toEqual([null, null, null]);
  });
});

describe('smsEvidence', () => {
  const sms = (over = {}) => ({ id: 'sms-1', customer_id: 'cust-1', created_at: ago(30), ...over });

  test('courtesy: nothing followed for 24h means the conversation simply ended (true)', async () => {
    const out = await smsEvidence(sms(), { now: NOW, conn: fakeConn() });
    expect(out.is_courtesy_only).toMatchObject({ source: 'sms_log', window: '24h', value: true });
  });

  test('courtesy: still inside 24h with nothing yet is unknown', async () => {
    const out = await smsEvidence(sms({ created_at: ago(2) }), { now: NOW, conn: fakeConn() });
    expect(out.is_courtesy_only.value).toBeNull();
  });

  test('courtesy: a later Waves text, a further inbound or an outbound call is false at once', async () => {
    for (const first of [{ sms_log: [{ id: 'o1' }] }, { sms_log: [undefined, { id: 'i1' }] }, { sms_log: [undefined, undefined], call_log: [{ id: 'c1' }] }]) {
      const out = await smsEvidence(sms({ created_at: ago(2) }), { now: NOW, conn: fakeConn({ first }) });
      expect(out.is_courtesy_only.value).toBe(false);
    }
  });

  test('courtesy: scoped to the text\'s own phone pair (another Waves line is another thread)', async () => {
    const conn = fakeConn();
    await smsEvidence(sms({ created_at: ago(30), from_phone: '+15550000001', to_phone: '+15550000002' }), { now: NOW, conn });
    const [outbound, inbound] = conn.log.filter((q) => q.table === 'sms_log');
    expect(outbound.calls[0]).toEqual(['where', [{ customer_id: 'cust-1', direction: 'outbound', to_phone: '+15550000001', from_phone: '+15550000002' }]]);
    expect(inbound.calls[0]).toEqual(['where', [{ customer_id: 'cust-1', direction: 'inbound', from_phone: '+15550000001', to_phone: '+15550000002' }]]);
  });

  test('courtesy: an outbound call counts only once the customer leg was bridged', async () => {
    const conn = fakeConn();
    await smsEvidence(sms({ created_at: ago(30) }), { now: NOW, conn });
    const calls = conn.log.find((q) => q.table === 'call_log');
    expect(calls.calls).toContainEqual(['whereNotNull', ['bridged_at']]);
  });

  test('courtesy: an outbound row counts only once it went out (queued/sent/delivered)', async () => {
    const conn = fakeConn();
    await smsEvidence(sms({ created_at: ago(30) }), { now: NOW, conn });
    const [outbound, inbound] = conn.log.filter((q) => q.table === 'sms_log');
    expect(outbound.calls).toContainEqual(['whereIn', ['status', ['queued', 'sent', 'delivered']]]);
    expect(inbound.calls).toContainEqual(['whereNotIn', ['status', ['failed', 'undelivered', 'blocked']]]);
  });

  test('visit change: a logged move, cancel or skip within 7d is true', async () => {
    const out = await smsEvidence(sms({ created_at: ago(5) }), { now: NOW, conn: fakeConn({ first: { job_status_history: [{ id: 'h1' }] } }) });
    expect(out.wants_visit_change).toMatchObject({ source: 'job_status_history', window: '7d', value: true });
  });

  test('courtesy: the source text itself is excluded from "a later contact"', async () => {
    const conn = fakeConn();
    await smsEvidence(sms({ created_at: ago(30) }), { now: NOW, conn });
    const smsQueries = conn.log.filter((q) => q.table === 'sms_log');
    expect(smsQueries.length).toBeGreaterThan(0);
    for (const q of smsQueries) expect(q.calls).toContainEqual(['whereNot', ['id', sms().id]]);
  });

  test('visit change: a reschedule_log row also counts', async () => {
    // the move query joins its visit, so the stub answers it as scheduled_services
    const out = await smsEvidence(sms({ created_at: ago(5) }), { now: NOW, conn: fakeConn({ first: { job_status_history: [undefined], scheduled_services: [{ id: 'r1' }] } }) });
    expect(out.wants_visit_change.value).toBe(true);
  });

  test('visit change: no move is false only after 7 days, unknown before', async () => {
    expect((await smsEvidence(sms({ created_at: ago(24 * 3) }), { now: NOW, conn: fakeConn() })).wants_visit_change.value).toBeNull();
    expect((await smsEvidence(sms({ created_at: ago(24 * 8) }), { now: NOW, conn: fakeConn() })).wants_visit_change.value).toBe(false);
  });

  test('a text with no customer is unknown on both questions', async () => {
    const out = await smsEvidence(sms({ customer_id: null, created_at: ago(24 * 20) }), { now: NOW, conn: fakeConn() });
    expect([out.wants_visit_change.value, out.is_courtesy_only.value]).toEqual([null, null]);
  });
});

describe('refreshOutcomeEvidence', () => {
  const original = process.env.GATE_TYPED_DECISIONS;
  beforeEach(() => { process.env.GATE_TYPED_DECISIONS = 'true'; });
  afterAll(() => { if (original === undefined) delete process.env.GATE_TYPED_DECISIONS; else process.env.GATE_TYPED_DECISIONS = original; });

  function refreshConn(reviews, subjects) {
    const updates = [];
    const conn = (name) => {
      const table = String(name).split(' as ')[0];
      const b = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return (res, rej) => Promise.resolve(table === 'decision_reviews' ? reviews : []).then(res, rej);
          if (prop === 'first') return async () => subjects[table];
          if (prop === 'update') return async (patch) => { updates.push(patch); return 1; };
          return () => b;
        },
      });
      return b;
    };
    return { conn, updates };
  }

  test('gate off: no read, no write', async () => {
    delete process.env.GATE_TYPED_DECISIONS;
    const conn = jest.fn();
    expect(await refreshOutcomeEvidence({ conn })).toMatchObject({ skipped: 'gate_off', checked: 0 });
    expect(conn).not.toHaveBeenCalled();
  });

  test('re-reads unknown evidence and writes only a reading that is no longer null', async () => {
    mockCallEndFor.mockReturnValue(ago(60));
    const { conn, updates } = refreshConn(
      [
        { id: 'r1', subject_type: 'call_log', subject_id: 'call-1', question_id: 'appointment_agreed' }, // 24h over, none found -> false
        { id: 'r2', subject_type: 'call_log', subject_id: 'call-1', question_id: 'is_lead' }, // 7d open -> still null, skipped
      ],
      { call_log: call() },
    );
    const out = await refreshOutcomeEvidence({ now: NOW, conn });
    expect(out).toEqual({ checked: 2, updated: 1 });
    expect(updates).toHaveLength(1);
    expect(JSON.parse(updates[0].outcome_evidence)).toMatchObject({ source: 'scheduled_services', window: '24h', value: false });
    expect(Object.keys(updates[0])).toEqual(['outcome_evidence']); // never a label column
  });
});
