// GET /api/billing/cards under GATE_PORTAL_CARD_REMOVAL_HOLD_NOTICE (owner
// ruling 2026-09-03): a card holding a future secured visit carries
// holdsAppointment (soonest visit, fee, reschedule link); gate off, no live
// hold, or a failed lookup → the field is ABSENT (payload unchanged). ONE
// batched lookup per request (Codex #3828 r1 P1). The reschedule link is
// offered only when reschedule-public's own eligibilityAsync says the page
// would honor it (r1 P1) — any failure = no link.

let mockGateOn = true;
jest.mock('../config/feature-gates', () => ({
  isEnabled: (name) => (name === 'portalCardRemovalHoldNotice' ? mockGateOn : false),
  gates: {},
}));
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.customerId = 'cust-1'; next(); },
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/stripe-config', () => ({}));
jest.mock('../services/stripe', () => ({}));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn() }));
jest.mock('../services/payment-lifecycle-email', () => ({}));
const mockLiveHolds = jest.fn();
jest.mock('../services/estimate-card-holds', () => ({ liveHoldsForPaymentMethods: (...a) => mockLiveHolds(...a) }));
const mockEligibility = jest.fn();
jest.mock('../routes/reschedule-public', () => ({ eligibilityAsync: (...a) => mockEligibility(...a) }));
jest.mock('../utils/service-normalizer', () => ({ normalizeServiceType: (raw) => `norm:${raw}` }));

const express = require('express');
const db = require('../models/db');
const logger = require('../services/logger');

const cardRows = [
  { id: 'pm-1', method_type: 'card', card_brand: 'VISA', last_four: '4242', exp_month: 12, exp_year: 2032, is_default: true, autopay_enabled: false, stripe_payment_method_id: 'pm_stripe_1' },
  { id: 'pm-2', method_type: 'card', card_brand: 'MC', last_four: '1881', exp_month: 1, exp_year: 2031, is_default: false, autopay_enabled: false, stripe_payment_method_id: 'pm_stripe_2' },
];

beforeEach(() => {
  mockGateOn = true;
  mockLiveHolds.mockReset().mockResolvedValue(new Map());
  mockEligibility.mockReset().mockResolvedValue({ ok: true });
  logger.warn.mockClear();
  db.mockImplementation(() => {
    const chain = {};
    for (const m of ['where', 'orderBy']) chain[m] = jest.fn(() => chain);
    chain.then = (resolve, reject) => Promise.resolve(cardRows).then(resolve, reject);
    return chain;
  });
});

async function getCards() {
  const app = express();
  app.use('/billing', require('../routes/billing-v2'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/billing/cards`);
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const start = new Date('2026-09-12T13:00:00.000Z');
const visit = { id: 'svc-9', visit_id: 'vg-1', status: 'confirmed', source_action: null, customer_confirmed: true, scheduled_date: '2026-09-12', window_start: '09:00:00', window_end: '10:00:00' };
const liveHold = { lane: 'card_hold', pmId: 'pm_stripe_2', scheduledServiceId: 'svc-9', start, serviceType: 'Pest Control', rescheduleToken: 'tok-9', feeAmount: 49, visit };
const holdsOn = (pmId, holds) => new Map([[pmId, holds]]);

test('gate off: no lookup, no field', async () => {
  mockGateOn = false;
  const { status, body } = await getCards();
  expect(status).toBe(200);
  expect(mockLiveHolds).not.toHaveBeenCalled();
  expect(body.cards.map((c) => 'holdsAppointment' in c)).toEqual([false, false]);
});

test('gate on: ONE batched lookup; the holding card carries the soonest visit, the other stays bare', async () => {
  mockLiveHolds.mockResolvedValue(holdsOn('pm_stripe_2', [liveHold, { ...liveHold, scheduledServiceId: 'svc-later' }]));
  const { body } = await getCards();
  expect(mockLiveHolds).toHaveBeenCalledTimes(1);
  expect(mockLiveHolds).toHaveBeenCalledWith({ customerId: 'cust-1', stripePaymentMethodIds: ['pm_stripe_1', 'pm_stripe_2'] });
  expect(body.cards[0].holdsAppointment).toBeUndefined();
  expect(body.cards[1].holdsAppointment).toEqual({
    serviceId: 'svc-9',
    start: start.toISOString(),
    serviceType: 'norm:Pest Control',
    feeAmount: 49,
    rescheduleUrl: '/reschedule/tok-9',
  });
  // The link comes from the reschedule page's OWN verdict on the visit row.
  expect(mockEligibility).toHaveBeenCalledWith(visit);
});

test.each([
  ['in_progress', { ok: false, reason: 'in_progress' }],
  ['dispatch-owned pending', { ok: false, reason: 'not_available' }],
  ['grouped', { ok: false, reason: 'grouped' }],
])('reschedule page would refuse (%s): no link, notice still shown', async (_label, verdict) => {
  mockLiveHolds.mockResolvedValue(holdsOn('pm_stripe_1', [liveHold]));
  mockEligibility.mockResolvedValue(verdict);
  const { body } = await getCards();
  expect(body.cards[0].holdsAppointment.rescheduleUrl).toBeNull();
  expect(body.cards[0].holdsAppointment.serviceId).toBe('svc-9');
});

test('eligibility lookup failure: no link (fail closed), notice still shown', async () => {
  mockLiveHolds.mockResolvedValue(holdsOn('pm_stripe_1', [liveHold]));
  mockEligibility.mockRejectedValue(new Error('db down'));
  const { body } = await getCards();
  expect(body.cards[0].holdsAppointment.rescheduleUrl).toBeNull();
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('reschedule eligibility failed for visit svc-9'));
});

test('no reschedule token: eligibility skipped, link null', async () => {
  mockLiveHolds.mockResolvedValue(holdsOn('pm_stripe_1', [{ ...liveHold, rescheduleToken: null }]));
  const { body } = await getCards();
  expect(mockEligibility).not.toHaveBeenCalled();
  expect(body.cards[0].holdsAppointment.rescheduleUrl).toBeNull();
});

test('hold lookup failure: every card bare, the list still renders, warning logged', async () => {
  mockLiveHolds.mockRejectedValue(new Error('db down'));
  const { status, body } = await getCards();
  expect(status).toBe(200);
  expect(body.cards.map((c) => 'holdsAppointment' in c)).toEqual([false, false]);
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('card-hold notice lookup failed for customer cust-1'));
});
