/**
 * getContextForCustomer attaches context.visitLoops: always present, never
 * throws, fed the aggregator's own upcoming rows + deriveWindow, and
 * non-enumerable so it never rides into other LLM-visible serializations of
 * the context (open promise text). Loaded only while GATE_SMS_REAL_ANSWERS is on.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/visit-loops-facts', () => ({
  loadVisitLoops: jest.fn(),
  emptyVisitLoops: () => ({ lateAlert: null, pastWindow: null, missedVisit: null, weOwe: [], customerWaiting: [] }),
}));

const db = require('../models/db');
db.schema = { hasTable: async () => true };
const { loadVisitLoops } = require('../services/visit-loops-facts');
const ContextAggregator = require('../services/context-aggregator');

function genericQuery(resolveValue = []) {
  const proxy = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(resolveValue).then(res, rej);
      if (prop === 'catch') return (rej) => Promise.resolve(resolveValue).then(undefined, rej);
      if (prop === 'first') return () => Promise.resolve(Array.isArray(resolveValue) ? (resolveValue[0] ?? null) : (resolveValue ?? null));
      if (prop === 'count') return () => ({ first: async () => ({ count: '0', c: '0' }) });
      return () => proxy;
    },
  });
  return proxy;
}

const customer = {
  id: 'cust-loops-1', first_name: 'Pat', last_name: 'Doe', phone: '+19415551234',
  email: 'pat@example.com', address_line1: '1 Main St', city: 'Bradenton', zip: '34205',
  waveguard_tier: null, monthly_rate: 0, pipeline_stage: 'active_customer', lead_score: null,
  customer_since: '2024-01-01', deleted_at: null, autopay_enabled: false,
  billing_mode: null, ach_status: null, autopay_paused_until: null, autopay_payment_method_id: null,
};

const today = (() => {
  const { etDateString } = require('../utils/datetime-et');
  return etDateString();
})();

afterEach(() => { delete process.env.GATE_SMS_REAL_ANSWERS; });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_SMS_REAL_ANSWERS = 'true';
  db.mockImplementation((table) => (String(table).startsWith('scheduled_services')
    ? genericQuery([{ id: 'visit-1', service_type: 'Pest Control', scheduled_date: today, window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed', technician_name: 'Jamie Rivera', track_state: null }])
    : genericQuery([])));
});

describe('getContextForCustomer visitLoops', () => {
  test('gate off: the loader is never called and visitLoops is the empty shape', async () => {
    delete process.env.GATE_SMS_REAL_ANSWERS;
    const context = await ContextAggregator.getContextForCustomer(customer, { includeVisitLoops: true });
    expect(loadVisitLoops).not.toHaveBeenCalled();
    expect(context.visitLoops).toEqual({ lateAlert: null, pastWindow: null, missedVisit: null, weOwe: [], customerWaiting: [] });
  });

  test('gate on but no opt-in (email replies, briefs, assistant): the loader is never called', async () => {
    const context = await ContextAggregator.getContextForCustomer(customer);
    expect(loadVisitLoops).not.toHaveBeenCalled();
    expect(context.visitLoops).toEqual({ lateAlert: null, pastWindow: null, missedVisit: null, weOwe: [], customerWaiting: [] });
  });

  test('attaches the loader result, passing customer id and the aggregator deriveWindow (the loader reads all of today itself)', async () => {
    const loops = { lateAlert: { visitId: 'visit-1', type: 'tech_late' }, pastWindow: null, missedVisit: null, weOwe: [], customerWaiting: [] };
    loadVisitLoops.mockResolvedValue(loops);
    const context = await ContextAggregator.getContextForCustomer(customer, { includeVisitLoops: true });
    expect(context.visitLoops).toBe(loops);
    const args = loadVisitLoops.mock.calls[0][0];
    expect(args.customerId).toBe(customer.id);
    expect(args).not.toHaveProperty('upcomingServices');
    expect(args.deriveWindow({ window_start: '09:00:00' })).toBe('9:00 AM–11:00 AM');
  });

  test('a loader that throws still yields an all-empty visitLoops (never a failed context)', async () => {
    loadVisitLoops.mockRejectedValue(new Error('boom'));
    const context = await ContextAggregator.getContextForCustomer(customer, { includeVisitLoops: true });
    expect(context.known).toBe(true);
    expect(context.visitLoops).toEqual({ lateAlert: null, pastWindow: null, missedVisit: null, weOwe: [], customerWaiting: [] });
  });

  test('visitLoops is non-enumerable: serialization and spreads of the context never carry it', async () => {
    loadVisitLoops.mockResolvedValue({ lateAlert: null, pastWindow: null, missedVisit: null, weOwe: [{ id: 'cc-1', kind: 'callback', description: 'raw promise text' }], customerWaiting: [] });
    const context = await ContextAggregator.getContextForCustomer(customer, { includeVisitLoops: true });
    expect(context.visitLoops.weOwe[0].description).toBe('raw promise text');
    expect(Object.keys(context)).not.toContain('visitLoops');
    expect(JSON.stringify(context)).not.toContain('raw promise text');
    expect({ ...context }.visitLoops).toBeUndefined();
  });
});
