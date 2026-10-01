/**
 * getContextForCustomer attaches context.visitLoops: always present, never
 * throws, fed the aggregator's own upcoming rows + deriveWindow, and
 * non-enumerable so it never rides into other LLM-visible serializations of
 * the context (raw tech notes / open promise text).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/visit-loops-facts', () => ({
  loadVisitLoops: jest.fn(),
  emptyVisitLoops: () => ({ techPosition: null, lateAlert: null, pastWindow: null, missedVisit: null, liveNote: null, weOwe: [], customerWaiting: [] }),
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

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation((table) => (String(table).startsWith('scheduled_services')
    ? genericQuery([{ id: 'visit-1', service_type: 'Pest Control', scheduled_date: today, window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed', technician_name: 'Jamie Rivera', track_state: null }])
    : genericQuery([])));
});

describe('getContextForCustomer visitLoops', () => {
  test('attaches the loader result, passing customer id, the mapped upcoming rows and the aggregator deriveWindow', async () => {
    const loops = { techPosition: { techName: 'Jamie', status: 'stale', minutesSinceUpdate: null, stopsAhead: 1, atThisVisit: false }, lateAlert: null, pastWindow: null, missedVisit: null, liveNote: null, weOwe: [], customerWaiting: [] };
    loadVisitLoops.mockResolvedValue(loops);
    const context = await ContextAggregator.getContextForCustomer(customer);
    expect(context.visitLoops).toBe(loops);
    const args = loadVisitLoops.mock.calls[0][0];
    expect(args.customerId).toBe(customer.id);
    expect(args.upcomingServices).toBe(context.upcomingServices);
    expect(args.upcomingServices[0]).toMatchObject({ isToday: true, tech: 'Jamie Rivera' });
    expect(args.upcomingServices[0].scheduledServiceId).toBe('visit-1');
    expect(args.deriveWindow({ window_start: '09:00:00' })).toBe('9:00 AM–11:00 AM');
  });

  test('a loader that throws still yields an all-empty visitLoops (never a failed context)', async () => {
    loadVisitLoops.mockRejectedValue(new Error('boom'));
    const context = await ContextAggregator.getContextForCustomer(customer);
    expect(context.known).toBe(true);
    expect(context.visitLoops).toEqual({ techPosition: null, lateAlert: null, pastWindow: null, missedVisit: null, liveNote: null, weOwe: [], customerWaiting: [] });
  });

  test('visitLoops is non-enumerable: serialization and spreads of the context never carry it', async () => {
    loadVisitLoops.mockResolvedValue({ techPosition: null, lateAlert: null, pastWindow: null, missedVisit: null, liveNote: { text: 'raw tech text', updatedAt: null }, weOwe: [], customerWaiting: [] });
    const context = await ContextAggregator.getContextForCustomer(customer);
    expect(context.visitLoops.liveNote.text).toBe('raw tech text');
    expect(Object.keys(context)).not.toContain('visitLoops');
    expect(JSON.stringify(context)).not.toContain('raw tech text');
    expect({ ...context }.visitLoops).toBeUndefined();
  });
});
