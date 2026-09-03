// liveHoldsForPaymentMethod (portal card-removal notice, owner ruling
// 2026-09-03): the future secured visits a saved card is holding, across
// BOTH fee rails, soonest first. Closed/parked/past/unresolvable rows drop;
// the same visit on both rails counts once; a failed read throws.

let mockRows = {};
let mockCalls = [];
jest.mock('../models/db', () => {
  const mock = jest.fn((table) => {
    const call = { table, where: [], whereNull: [], whereNotNull: [], whereNotIn: [] };
    mockCalls.push(call);
    const chain = {};
    chain.join = jest.fn(() => chain);
    chain.where = jest.fn((c) => { call.where.push(c); return chain; });
    chain.whereNull = jest.fn((c) => { call.whereNull.push(c); return chain; });
    chain.whereNotNull = jest.fn((c) => { call.whereNotNull.push(c); return chain; });
    chain.whereNotIn = jest.fn((c, v) => { call.whereNotIn.push([c, v]); return chain; });
    chain.select = jest.fn(() => chain);
    chain.then = (resolve, reject) => {
      const rows = mockRows[table.split(' ')[0]];
      return (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows || [])).then(resolve, reject);
    };
    return chain;
  });
  mock.fn = { now: jest.fn() };
  mock.raw = jest.fn();
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/stripe', () => ({}));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gates: {} }));
jest.mock('../services/appointment-reminders', () => ({
  composeScheduledApptTime: (svc) => (svc.scheduled_date && svc.window_start
    ? new Date(`${svc.scheduled_date}T${svc.window_start}-04:00`)
    : null),
}));

const { liveHoldsForPaymentMethod, cardHoldNoShowFee } = require('../services/estimate-card-holds');

const now = new Date('2026-09-03T12:00:00-04:00');
const visit = (over) => ({ service_id: 'svc-a', visit_id: 'vg-a', scheduled_date: '2026-09-12', window_start: '09:00:00', service_type: 'Pest Control', reschedule_token: 'tok-a', no_show_fee_amount: '49.00', ...over });

beforeEach(() => { mockRows = {}; mockCalls = []; });

test('empty args: no read', async () => {
  expect(await liveHoldsForPaymentMethod({ customerId: null, stripePaymentMethodId: 'pm_1' })).toEqual([]);
  expect(mockCalls).toHaveLength(0);
});

test('queries carry the live-row predicates on both rails', async () => {
  await liveHoldsForPaymentMethod({ customerId: 'c1', stripePaymentMethodId: 'pm_1', now });
  const [holds, appts] = mockCalls;
  expect(holds.table).toBe('estimate_card_holds as h');
  expect(holds.where[0]).toEqual({ 'h.customer_id': 'c1', 'h.stripe_payment_method_id': 'pm_1', 'h.status': 'held' });
  expect(holds.whereNull).toEqual(['h.parked_at']);
  expect(holds.whereNotIn[0]).toEqual(['ss.status', ['cancelled', 'completed', 'no_show', 'skipped']]);
  expect(appts.table).toBe('appointment_card_requests as r');
  expect(appts.where[0]).toEqual({ 'r.customer_id': 'c1', 'r.stripe_payment_method_id': 'pm_1', 'r.status': 'completed' });
  expect(appts.whereNotNull).toEqual(['r.fee_agreed_at']);
  expect(appts.whereNull).toEqual(['r.fee_status']);
});

test('future visits from both rails, soonest first, frozen fee kept, default fee when blank', async () => {
  mockRows.estimate_card_holds = [visit({ service_id: 'svc-late', scheduled_date: '2026-09-20', no_show_fee_amount: '75.00' })];
  mockRows.appointment_card_requests = [visit({ service_id: 'svc-soon', scheduled_date: '2026-09-05', reschedule_token: null, no_show_fee_amount: null })];
  const live = await liveHoldsForPaymentMethod({ customerId: 'c1', stripePaymentMethodId: 'pm_1', now });
  expect(live.map((l) => [l.lane, l.scheduledServiceId, l.feeAmount, l.rescheduleToken])).toEqual([
    ['appointment_card', 'svc-soon', cardHoldNoShowFee(), null],
    ['card_hold', 'svc-late', 75, 'tok-a'],
  ]);
  expect(live[1]).toMatchObject({ groupVisitId: 'vg-a', serviceType: 'Pest Control' });
  expect(live[0].start.toISOString()).toBe(new Date('2026-09-05T09:00:00-04:00').toISOString());
});

test('past and unresolvable starts drop; the same visit on both rails counts once', async () => {
  mockRows.estimate_card_holds = [
    visit({ service_id: 'svc-past', scheduled_date: '2026-09-01' }),
    visit({ service_id: 'svc-now', scheduled_date: '2026-09-03', window_start: '12:00:00' }),
    visit({ service_id: 'svc-notime', window_start: null }),
    visit({ service_id: 'svc-dup' }),
  ];
  mockRows.appointment_card_requests = [visit({ service_id: 'svc-dup', no_show_fee_amount: '10.00' })];
  const live = await liveHoldsForPaymentMethod({ customerId: 'c1', stripePaymentMethodId: 'pm_1', now });
  expect(live.map((l) => [l.lane, l.scheduledServiceId, l.feeAmount])).toEqual([['card_hold', 'svc-dup', 49]]);
});

test('a failed read throws — the caller decides the failure posture', async () => {
  mockRows.appointment_card_requests = new Error('db down');
  await expect(liveHoldsForPaymentMethod({ customerId: 'c1', stripePaymentMethodId: 'pm_1', now })).rejects.toThrow('db down');
});
