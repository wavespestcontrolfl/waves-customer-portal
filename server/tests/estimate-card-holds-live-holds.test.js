// liveHoldsForPaymentMethods (portal card-removal notice, owner ruling
// 2026-09-03): the future secured visits the wallet's cards are holding,
// across BOTH fee rails, ONE batched read per rail (Codex #3828 r1 P1),
// grouped by Stripe pm and soonest first. Closed/parked/past/unresolvable
// rows drop; the same visit on both rails counts once; an appointment-rail
// visit a third-party payer took over drops (r1 P2, fail closed on an
// unresolvable payer); a failed rail read throws.

let mockRows = {};
let mockCalls = [];
jest.mock('../models/db', () => {
  const mock = jest.fn((table) => {
    const call = { table, where: [], whereIn: [], whereNull: [], whereNotNull: [], whereNotIn: [] };
    mockCalls.push(call);
    const chain = {};
    chain.join = jest.fn(() => chain);
    chain.where = jest.fn((c) => { call.where.push(c); return chain; });
    chain.whereIn = jest.fn((c, v) => { call.whereIn.push([c, v]); return chain; });
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
const mockResolvePayer = jest.fn(async () => ({ payerId: null }));
jest.mock('../services/payer', () => ({ resolveForInvoice: (...a) => mockResolvePayer(...a) }));

const { liveHoldsForPaymentMethods, cardHoldNoShowFee } = require('../services/estimate-card-holds');
const logger = require('../services/logger');

const now = new Date('2026-09-03T12:00:00-04:00');
const visit = (over) => ({
  service_id: 'svc-a', visit_id: 'vg-a', visit_status: 'confirmed', source_action: null, customer_confirmed: true,
  scheduled_date: '2026-09-12', window_start: '09:00:00', window_end: '10:00:00', service_type: 'Pest Control',
  reschedule_token: 'tok-a', pm_id: 'pm_1', no_show_fee_amount: '49.00', ...over,
});
const run = (ids = ['pm_1', 'pm_2']) => liveHoldsForPaymentMethods({ customerId: 'c1', stripePaymentMethodIds: ids, now });
const flat = (map) => [...map.entries()].flatMap(([pm, holds]) => holds.map((h) => [pm, h.lane, h.scheduledServiceId, h.feeAmount]));

beforeEach(() => { mockRows = {}; mockCalls = []; mockResolvePayer.mockClear().mockResolvedValue({ payerId: null }); logger.warn.mockClear(); });

test('empty args: no read', async () => {
  expect((await liveHoldsForPaymentMethods({ customerId: null, stripePaymentMethodIds: ['pm_1'] })).size).toBe(0);
  expect((await liveHoldsForPaymentMethods({ customerId: 'c1', stripePaymentMethodIds: [null, undefined] })).size).toBe(0);
  expect(mockCalls).toHaveLength(0);
});

test('ONE read per rail carrying the live-row predicates and the whole (deduped) pm list', async () => {
  await run(['pm_1', 'pm_2', 'pm_1']);
  expect(mockCalls).toHaveLength(2);
  const [holds, appts] = mockCalls;
  expect(holds.table).toBe('estimate_card_holds as h');
  expect(holds.where[0]).toEqual({ 'h.customer_id': 'c1', 'h.status': 'held' });
  expect(holds.whereIn).toEqual([['h.stripe_payment_method_id', ['pm_1', 'pm_2']]]);
  expect(holds.whereNull).toEqual(['h.parked_at']);
  expect(holds.whereNotIn[0]).toEqual(['ss.status', ['cancelled', 'rescheduled', 'completed', 'skipped', 'no_show']]);
  expect(appts.table).toBe('appointment_card_requests as r');
  expect(appts.where[0]).toEqual({ 'r.customer_id': 'c1', 'r.status': 'completed' });
  expect(appts.whereIn).toEqual([['r.stripe_payment_method_id', ['pm_1', 'pm_2']]]);
  expect(appts.whereNotNull).toEqual(['r.fee_agreed_at']);
  expect(appts.whereNull).toEqual(['r.fee_status']);
  expect(appts.whereNotIn[0]).toEqual(holds.whereNotIn[0]);
});

test('grouped by pm, soonest first, frozen fee kept, default fee when blank, visit columns for eligibility', async () => {
  mockRows.estimate_card_holds = [visit({ service_id: 'svc-late', scheduled_date: '2026-09-20', no_show_fee_amount: '75.00' })];
  mockRows.appointment_card_requests = [
    visit({ service_id: 'svc-soon', scheduled_date: '2026-09-05', reschedule_token: null, no_show_fee_amount: null }),
    visit({ service_id: 'svc-other', pm_id: 'pm_2', scheduled_date: '2026-09-08' }),
  ];
  const map = await run();
  expect(flat(map)).toEqual([
    ['pm_1', 'appointment_card', 'svc-soon', cardHoldNoShowFee()],
    ['pm_1', 'card_hold', 'svc-late', 75],
    ['pm_2', 'appointment_card', 'svc-other', 49],
  ]);
  const late = map.get('pm_1')[1];
  expect(late).toMatchObject({ rescheduleToken: 'tok-a', serviceType: 'Pest Control' });
  expect(late.visit).toEqual({ id: 'svc-late', visit_id: 'vg-a', status: 'confirmed', source_action: null, customer_confirmed: true, scheduled_date: '2026-09-20', window_start: '09:00:00', window_end: '10:00:00' });
  expect(map.get('pm_1')[0].start.toISOString()).toBe(new Date('2026-09-05T09:00:00-04:00').toISOString());
});

test('past and unresolvable starts drop; the same visit on both rails counts once', async () => {
  mockRows.estimate_card_holds = [
    visit({ service_id: 'svc-past', scheduled_date: '2026-09-01' }),
    visit({ service_id: 'svc-now', scheduled_date: '2026-09-03', window_start: '12:00:00' }),
    visit({ service_id: 'svc-notime', window_start: null }),
    visit({ service_id: 'svc-dup' }),
  ];
  mockRows.appointment_card_requests = [visit({ service_id: 'svc-dup', no_show_fee_amount: '10.00' })];
  expect(flat(await run())).toEqual([['pm_1', 'card_hold', 'svc-dup', 49]]);
  expect(mockResolvePayer).not.toHaveBeenCalled();
});

test('appointment-rail visit a payer took over drops; the hold rail never asks', async () => {
  mockRows.estimate_card_holds = [visit({ service_id: 'svc-hold' })];
  mockRows.appointment_card_requests = [visit({ service_id: 'svc-payer', scheduled_date: '2026-09-06' }), visit({ service_id: 'svc-self', scheduled_date: '2026-09-07' })];
  mockResolvePayer.mockImplementation(async ({ scheduledServiceId }) => ({ payerId: scheduledServiceId === 'svc-payer' ? 'payer-1' : null }));
  expect(flat(await run()).map((r) => r[2])).toEqual(['svc-self', 'svc-hold']);
  expect(mockResolvePayer).toHaveBeenCalledWith({ customerId: 'c1', scheduledServiceId: 'svc-payer', throwOnError: true });
  expect(mockResolvePayer).toHaveBeenCalledTimes(2);
});

test('an unresolvable payer drops the appointment-rail row (fail closed) with a warning', async () => {
  mockRows.appointment_card_requests = [visit({ service_id: 'svc-x' })];
  mockResolvePayer.mockRejectedValue(new Error('payer db down'));
  expect((await run()).size).toBe(0);
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('payer resolve failed for visit svc-x'));
});

test('a failed rail read throws — the caller decides the failure posture', async () => {
  mockRows.appointment_card_requests = new Error('db down');
  await expect(run()).rejects.toThrow('db down');
});
