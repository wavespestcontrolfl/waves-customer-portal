// Outcome evidence: what the database recorded AFTER a call or text. null =
// unknown (missing linkage or window not elapsed), never a negative.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
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

  test('a move filed in reschedule_log (no status row) also counts', async () => {
    mockCallEndFor.mockReturnValue(ago(5));
    const out = await callEvidence(call(), { now: NOW, conn: fakeConn({ first: { scheduled_services: [undefined], job_status_history: [undefined], reschedule_log: [{ id: 'r1' }] } }) });
    expect(out.appointment_agreed.value).toBe(true);
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
    const out = await smsEvidence(sms({ created_at: ago(5) }), { now: NOW, conn: fakeConn({ first: { reschedule_log: [{ id: 'r1' }] } }) });
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
