// GET /api/billing/cards under GATE_PORTAL_CARD_REMOVAL_HOLD_NOTICE (owner
// ruling 2026-09-03): a card holding a future secured visit carries
// holdsAppointment (soonest visit, fee, reschedule link); gate off, no live
// hold, or a failed lookup → the field is ABSENT (payload unchanged). The
// reschedule link follows GET /schedule's grouped-stop posture: grouped or
// unknown membership → null.

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
jest.mock('../services/payment-router', () => ({ getServiceForCustomer: jest.fn() }));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn() }));
jest.mock('../services/payment-lifecycle-email', () => ({}));
const mockLiveHolds = jest.fn();
jest.mock('../services/estimate-card-holds', () => ({ liveHoldsForPaymentMethod: (...a) => mockLiveHolds(...a) }));
const mockGrouped = jest.fn();
jest.mock('../routes/reschedule-public', () => ({ groupedVisit: (...a) => mockGrouped(...a) }));
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
  mockLiveHolds.mockReset();
  mockGrouped.mockReset().mockResolvedValue(false);
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
const liveHold = { lane: 'card_hold', scheduledServiceId: 'svc-9', groupVisitId: 'vg-1', start, serviceType: 'Pest Control', rescheduleToken: 'tok-9', feeAmount: 49 };

test('gate off: no lookup, no field', async () => {
  mockGateOn = false;
  const { status, body } = await getCards();
  expect(status).toBe(200);
  expect(mockLiveHolds).not.toHaveBeenCalled();
  expect(body.cards.map((c) => 'holdsAppointment' in c)).toEqual([false, false]);
});

test('gate on: the holding card carries the soonest visit; the other card stays bare', async () => {
  mockLiveHolds.mockImplementation(async ({ stripePaymentMethodId }) => (stripePaymentMethodId === 'pm_stripe_2' ? [liveHold] : []));
  const { body } = await getCards();
  expect(mockLiveHolds).toHaveBeenCalledWith({ customerId: 'cust-1', stripePaymentMethodId: 'pm_stripe_1' });
  expect(body.cards[0].holdsAppointment).toBeUndefined();
  expect(body.cards[1].holdsAppointment).toEqual({
    serviceId: 'svc-9',
    start: start.toISOString(),
    serviceType: 'norm:Pest Control',
    feeAmount: 49,
    rescheduleUrl: '/reschedule/tok-9',
  });
  expect(mockGrouped).toHaveBeenCalledWith({ id: 'svc-9', visit_id: 'vg-1' });
});

test.each([[true], ['unknown']])('grouped verdict %p: no reschedule link', async (verdict) => {
  mockLiveHolds.mockResolvedValue([liveHold]);
  mockGrouped.mockResolvedValue(verdict);
  const { body } = await getCards();
  expect(body.cards[0].holdsAppointment.rescheduleUrl).toBeNull();
});

test('no reschedule token: grouped lookup skipped, link null', async () => {
  mockLiveHolds.mockResolvedValue([{ ...liveHold, rescheduleToken: null }]);
  const { body } = await getCards();
  expect(mockGrouped).not.toHaveBeenCalled();
  expect(body.cards[0].holdsAppointment.rescheduleUrl).toBeNull();
});

test('lookup failure on one card: that card is bare, the list still renders, warning logged', async () => {
  mockLiveHolds.mockImplementation(async ({ stripePaymentMethodId }) => {
    if (stripePaymentMethodId === 'pm_stripe_1') throw new Error('db down');
    return [liveHold];
  });
  const { status, body } = await getCards();
  expect(status).toBe(200);
  expect(body.cards[0].holdsAppointment).toBeUndefined();
  expect(body.cards[1].holdsAppointment.serviceId).toBe('svc-9');
  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('card-hold notice lookup failed for method pm-1'));
});
