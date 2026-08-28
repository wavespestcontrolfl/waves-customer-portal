// GET /api/billing/autopay names the method charge() would ACTUALLY bill
// (owner ruling 2026-08-27, P1): with legacy duplicate default+enabled
// rows the old unordered .first() could show "ending in 1234" while
// collection charged 5678. Now: getChargeableAutopayMethod (pointer first,
// then the deterministic walk) — one resolver for display, removal guard,
// and charging. Also exposes the selected-id set + the guard gate state the
// Payment Methods row hierarchy renders from.

let mockGateOn = false;
jest.mock('../config/feature-gates', () => ({
  isEnabled: (name) => (name === 'portalMethodRemovalGuard' ? mockGateOn : false),
  gates: {},
}));
jest.mock('stripe', () => jest.fn(() => ({})));
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.customerId = 'cust-1'; next(); },
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/stripe-config', () => ({}));
jest.mock('../services/autopay-log', () => ({
  logAutopay: jest.fn().mockResolvedValue(null),
  getRecent: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/payment-lifecycle-email', () => ({
  sendAutopayEnabled: jest.fn(), sendAutopayDisabled: jest.fn(), sendPaymentMethodUpdated: jest.fn(),
}));
jest.mock('../services/billing-lane', () => ({ resolveBillingLane: () => ({ mode: 'monthly_membership' }) }));

const express = require('express');
const db = require('../models/db');

let state;
function builderFor(table) {
  const b = {};
  const conds = [];
  const rows = () => (state[table] || []).filter((r) => conds.every((c) => c(r)));
  b.where = jest.fn((criteria) => {
    if (typeof criteria === 'object' && criteria !== null) {
      Object.entries(criteria).forEach(([k, v]) => conds.push((r) => r[k] === v));
    }
    return b;
  });
  for (const m of ['select', 'orderBy', 'whereNotNull']) b[m] = jest.fn(() => b);
  b.first = jest.fn(async () => rows()[0] || null);
  b.then = (resolve, reject) => Promise.resolve(rows()).then(resolve, reject);
  return b;
}

async function getAutopay() {
  const app = express();
  app.use('/billing/autopay', require('../routes/customer-autopay'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  try {
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/billing/autopay`);
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const pm = (overrides) => ({
  customer_id: 'cust-1', processor: 'stripe', method_type: 'card', exp_month: 12, exp_year: 2032,
  is_default: true, autopay_enabled: true, ach_status: null, card_brand: 'VISA', card_funding: 'credit', ...overrides,
});

beforeEach(() => {
  mockGateOn = false;
  db.mockImplementation((table) => builderFor(table));
  db.raw = jest.fn((s) => s);
  state = {
    customers: [{
      id: 'cust-1', monthly_rate: 100, waveguard_tier: null, autopay_enabled: true, autopay_paused_until: null,
      autopay_pause_reason: null, autopay_payment_method_id: 'pm-5678', billing_day: 1, next_charge_date: null, ach_status: null,
      billing_mode: 'monthly_membership',
    }],
    payment_methods: [
      // Legacy duplicate defaults: the NEWER row is what an unordered
      // .first() tends to surface; the pointer is the older one.
      pm({ id: 'pm-1234', stripe_payment_method_id: 'pm_1234', last_four: '1234', updated_at: '2026-08-01' }),
      pm({ id: 'pm-5678', stripe_payment_method_id: 'pm_5678', last_four: '5678', updated_at: '2026-01-01' }),
    ],
  };
});

afterEach(() => jest.clearAllMocks());

test('names the POINTER method, not whichever default+enabled row the DB returned first', async () => {
  const { status, body } = await getAutopay();
  expect(status).toBe(200);
  expect(body.autopay_payment_method_id).toBe('pm-5678');
  expect(body.state).toBe('active');
  expect(body.autopay_selected_method_ids).toEqual(['pm-5678']);
  expect(body.removal_guard).toBe(false);
});

test('an EXPIRED pointer falls through to the chargeable walk for display, but stays in the selected set', async () => {
  const old = state.payment_methods.find((p) => p.id === 'pm-5678');
  old.exp_month = 1; old.exp_year = 2020;
  const { body } = await getAutopay();
  expect(body.autopay_payment_method_id).toBe('pm-1234');
  expect(body.autopay_selected_method_ids.sort()).toEqual(['pm-1234', 'pm-5678']);
});

test('a chargeable pointer on a NON-default row still reads as active (resolver normalization preserved through the display re-read)', async () => {
  state.payment_methods.find((p) => p.id === 'pm-5678').is_default = false;
  const { body } = await getAutopay();
  expect(body.autopay_payment_method_id).toBe('pm-5678');
  expect(body.state).toBe('active');
  expect(body.autopay_enabled).toBe(true);
});

test('removal_guard echoes the gate so the row hierarchy flips with the server guard', async () => {
  mockGateOn = true;
  const { body } = await getAutopay();
  expect(body.removal_guard).toBe(true);
});

test('Auto Pay off → no selected ids, state disabled', async () => {
  state.customers[0].autopay_enabled = false;
  const { body } = await getAutopay();
  expect(body.state).toBe('disabled');
  expect(body.autopay_selected_method_ids).toEqual([]);
});
