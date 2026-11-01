/**
 * getContextForCustomer({ asOf }): late drafts (services/sms-late-drafter.js) cap every MESSAGE
 * source at the inbound's own instant, so a reply staff sent in between never reaches the prompt.
 * Unset, the reads are exactly today's (no extra where on any of these tables).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/visit-loops-facts', () => ({
  loadVisitLoops: jest.fn(async () => ({ lateAlert: null, pastWindow: null, weOwe: [], customerWaiting: [] })),
  emptyVisitLoops: () => ({ lateAlert: null, pastWindow: null, weOwe: [], customerWaiting: [] }),
}));

const db = require('../models/db');
db.schema = { hasTable: async () => true };
const { loadVisitLoops } = require('../services/visit-loops-facts');
const ContextAggregator = require('../services/context-aggregator');

// A chainable fake knex that records every builder call per table. modify() runs its callback on
// the chain so the call_log bounds (applied inside modify) are recorded too.
let queries;
function recordingQuery(table) {
  const calls = [];
  queries.push({ table, calls });
  const proxy = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve([]).then(res, rej);
      if (prop === 'catch') return (rej) => Promise.resolve([]).then(undefined, rej);
      if (prop === 'first') return () => Promise.resolve(null);
      if (prop === 'count') return () => ({ first: async () => ({ count: '0', c: '0' }) });
      if (prop === 'modify') return (fn) => { fn(proxy); return proxy; };
      return (...args) => { calls.push([prop, args]); return proxy; };
    },
  });
  return proxy;
}

const customer = {
  id: 'cust-asof-1', first_name: 'Pat', last_name: 'Doe', phone: '+19415551234',
  email: 'pat@example.com', address_line1: '1 Main St', city: 'Bradenton', zip: '34205',
  waveguard_tier: null, monthly_rate: 0, pipeline_stage: 'active_customer', lead_score: null,
  customer_since: '2024-01-01', deleted_at: null, autopay_enabled: false,
  billing_mode: null, ach_status: null, autopay_paused_until: null, autopay_payment_method_id: null,
};

const ASOF = new Date('2026-11-01T14:00:00Z');
const cap = (calls, column, op) => calls.some(([m, a]) => m === 'where' && a[0] === column && a[1] === op && a[2] instanceof Date && a[2].getTime() === ASOF.getTime());
const forTable = (table) => queries.filter((q) => q.table === table);

afterEach(() => { delete process.env.GATE_SMS_REAL_ANSWERS; });

beforeEach(() => {
  jest.clearAllMocks();
  // the visit loops load only while GATE_SMS_REAL_ANSWERS is on
  process.env.GATE_SMS_REAL_ANSWERS = 'true';
  queries = [];
  db.mockImplementation((table) => recordingQuery(table));
});

describe('getContextForCustomer asOf', () => {
  test('caps the sms_log thread (the 20 newest rows) at the inbound instant, inclusive', async () => {
    await ContextAggregator.getContextForCustomer(customer, { asOf: ASOF });
    const thread = forTable('sms_log');
    expect(thread).toHaveLength(1);
    expect(cap(thread[0].calls, 'created_at', '<=')).toBe(true);
    // the cap is applied before the limit, so a later reply cannot crowd an earlier row out
    const methods = thread[0].calls.map(([m]) => m);
    expect(methods.indexOf('where')).toBeLessThan(methods.indexOf('limit'));
  });

  test('caps the interaction log, the complaint list and the reschedule requests', async () => {
    await ContextAggregator.getContextForCustomer(customer, { asOf: ASOF });
    const interactions = forTable('customer_interactions');
    expect(interactions).toHaveLength(2);
    for (const q of interactions) expect(cap(q.calls, 'created_at', '<=')).toBe(true);
    const reschedules = forTable('reschedule_log');
    expect(reschedules).toHaveLength(1);
    expect(cap(reschedules[0].calls, 'created_at', '<=')).toBe(true);
  });

  test('caps call summaries and transcripts: the call must have started AND last been written by the inbound instant', async () => {
    await ContextAggregator.getContextForCustomer(customer, { asOf: ASOF });
    const calls = forTable('call_log');
    expect(calls).toHaveLength(1);
    expect(cap(calls[0].calls, 'created_at', '<=')).toBe(true);
    expect(cap(calls[0].calls, 'updated_at', '<=')).toBe(true);
  });

  test('hands the instant to the visit loops, which cap open promises and asks', async () => {
    await ContextAggregator.getContextForCustomer(customer, { includeVisitLoops: true, asOf: ASOF });
    expect(loadVisitLoops).toHaveBeenCalledTimes(1);
    expect(loadVisitLoops.mock.calls[0][0].asOf).toEqual(ASOF);
  });

  test('without asOf nothing is capped: no created_at <= on any message table, no asOf to the visit loops', async () => {
    await ContextAggregator.getContextForCustomer(customer, { includeVisitLoops: true });
    for (const table of ['sms_log', 'customer_interactions', 'reschedule_log', 'call_log']) {
      for (const q of forTable(table)) {
        expect(q.calls.some(([m, a]) => m === 'where' && a[0] === 'created_at' && a[1] === '<=')).toBe(false);
        expect(q.calls.some(([m, a]) => m === 'where' && a[0] === 'updated_at')).toBe(false);
      }
    }
    expect(loadVisitLoops.mock.calls[0][0]).not.toHaveProperty('asOf');
  });

  test('an invalid asOf is ignored like an unset one', async () => {
    await ContextAggregator.getContextForCustomer(customer, { includeVisitLoops: true, asOf: 'not a date' });
    expect(forTable('sms_log')[0].calls.some(([m, a]) => m === 'where' && a[0] === 'created_at')).toBe(false);
    expect(loadVisitLoops.mock.calls[0][0]).not.toHaveProperty('asOf');
  });

  test('getRecentCalls keeps its own before bound and adds the asOf bounds beside it', async () => {
    const before = new Date('2026-11-01T13:00:00Z');
    await ContextAggregator.getRecentCalls(customer.id, { before, asOf: ASOF });
    const [{ calls }] = forTable('call_log');
    expect(calls.some(([m, a]) => m === 'where' && a[0] === 'created_at' && a[1] === '<' && a[2] === before)).toBe(true);
    expect(cap(calls, 'created_at', '<=')).toBe(true);
    expect(cap(calls, 'updated_at', '<=')).toBe(true);
  });
});
