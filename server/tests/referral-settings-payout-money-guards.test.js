/**
 * Referral money guards: settings and payouts must never carry a negative,
 * fractional or non-numeric amount (fail closed, nothing written).
 *
 * Bug (admin Referrals audit F2): PUT /settings saved referrer_reward_cents
 * = -2500, which later staged a negative reward into promoter balances;
 * POST /payouts/:id/request let a negative min_payout_cents wave through a
 * negative amount; POST /payouts/:id/approve applied a negative payout row.
 *
 * Drives the REAL routes + REAL engine over a mocked knex.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  fn.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn() }));
jest.mock('../services/customer-credit', () => ({
  postCreditMovement: jest.fn(),
  round2: (n) => Math.round(n * 100) / 100,
}));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.techRole = 'admin';
      req.technicianId = 'tech-1';
      return next();
    },
  };
});

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-referrals-v2');

function freshState(overrides = {}) {
  return {
    settings: { id: 1, program_active: true, min_payout_cents: 1000, referrer_reward_cents: 2500 },
    promoter: { id: 'promo-1', available_balance_cents: 5000, referral_balance_cents: 5000, total_paid_out_cents: 0 },
    payout: { id: 'pay-1', promoter_id: 'promo-1', status: 'pending', amount_cents: 1500 },
    updates: [],
    inserts: [],
    ...overrides,
  };
}

function makeChain(table, state) {
  const chain = {};
  ['where', 'whereRaw', 'forUpdate', 'select', 'orderBy'].forEach((m) => { chain[m] = jest.fn(() => chain); });
  chain.first = jest.fn(async () => {
    if (table === 'referral_program_settings') return { ...state.settings };
    if (table === 'referral_promoters') return state.promoter ? { ...state.promoter } : null;
    if (table === 'referral_payouts') return state.payout ? { ...state.payout } : null;
    return null;
  });
  chain.sum = jest.fn(() => chain);
  chain.update = jest.fn(async (vals) => {
    state.updates.push({ table, vals });
    if (table === 'referral_program_settings') Object.assign(state.settings, vals);
    return 1;
  });
  chain.insert = jest.fn((vals) => {
    state.inserts.push({ table, vals });
    return { returning: async () => [{ id: 'new-payout', ...vals }] };
  });
  return chain;
}

function primeDb(state) {
  const trx = jest.fn((table) => makeChain(table, state));
  trx.raw = db.raw;
  db.transaction.mockImplementation(async (cb) => cb(trx));
  db.mockImplementation((table) => makeChain(table, state));
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/referrals', router);
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const send = (base, method, path, body) => fetch(`${base}/admin/referrals${path}`, {
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
});

beforeEach(() => jest.clearAllMocks());

describe('PUT /settings validation', () => {
  const bad = [
    ['referrer_reward_cents', -2500],
    ['referee_discount_cents', 12.5],
    ['min_payout_cents', 'abc'],
    ['bonus_gold_cents', null],
    ['milestone_5_bonus_cents', '-1'],
    ['max_referrals_per_month', -1],
    ['cooldown_days', 1.5],
    ['program_active', 'yes'],
    ['auto_credit_enabled', 1],
    ['invite_sms_template', 42],
  ];

  test.each(bad)('%s = %p is refused with 400 and nothing is written', async (key, value) => {
    const state = freshState();
    primeDb(state);
    await withServer(async (base) => {
      const res = await send(base, 'PUT', '/settings', { [key]: value });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain(key);
      expect(state.updates).toHaveLength(0);
      expect(state.settings.referrer_reward_cents).toBe(2500);
    });
  });

  test('one bad field blocks the whole save, even beside valid fields', async () => {
    const state = freshState();
    primeDb(state);
    await withServer(async (base) => {
      const res = await send(base, 'PUT', '/settings', { cooldown_days: 10, referrer_reward_cents: -1 });
      expect(res.status).toBe(400);
      expect(state.updates).toHaveLength(0);
    });
  });

  test('valid settings still save (numbers, clean numeric strings, booleans, templates)', async () => {
    const state = freshState();
    primeDb(state);
    await withServer(async (base) => {
      const res = await send(base, 'PUT', '/settings', {
        referrer_reward_cents: 3000,
        min_payout_cents: '1500',
        max_referrals_per_month: 0,
        program_active: false,
        invite_sms_template: null,
        reward_sms_template: 'Thanks!',
        base_url: 'https://example.test/r/',
      });
      expect(res.status).toBe(200);
      expect(state.updates).toHaveLength(1);
      expect(state.updates[0].vals).toMatchObject({
        referrer_reward_cents: 3000,
        min_payout_cents: 1500,
        max_referrals_per_month: 0,
        program_active: false,
        invite_sms_template: null,
        reward_sms_template: 'Thanks!',
      });
    });
  });
});

describe('POST /payouts/:id/request', () => {
  test('negative amount with a negative minimum is refused and no payout is inserted', async () => {
    const state = freshState({ settings: { id: 1, min_payout_cents: -5000 } });
    primeDb(state);
    await withServer(async (base) => {
      const res = await send(base, 'POST', '/payouts/promo-1/request', { amount: -300 });
      expect(res.status).toBe(400);
      expect(state.inserts).toHaveLength(0);
    });
  });

  test.each([0, 12.5, 'abc'])('amount %p is refused', async (amount) => {
    const state = freshState({ settings: { id: 1, min_payout_cents: 0 } });
    primeDb(state);
    await withServer(async (base) => {
      const res = await send(base, 'POST', '/payouts/promo-1/request', { amount });
      expect(res.status).toBe(400);
      expect(state.inserts).toHaveLength(0);
    });
  });

  test('valid amount inserts a pending payout; no amount requests the full balance', async () => {
    const state = freshState();
    primeDb(state);
    await withServer(async (base) => {
      expect((await send(base, 'POST', '/payouts/promo-1/request', { amount: 2000 })).status).toBe(200);
      expect((await send(base, 'POST', '/payouts/promo-1/request', {})).status).toBe(200);
      expect(state.inserts.map((i) => i.vals.amount_cents)).toEqual([2000, 5000]);
    });
  });
});

describe('POST /payouts/:id/approve', () => {
  test.each([-1500, 0])('a payout row of %p cents is refused and balances are untouched', async (amount_cents) => {
    const state = freshState({ payout: { id: 'pay-1', promoter_id: 'promo-1', status: 'pending', amount_cents } });
    primeDb(state);
    await withServer(async (base) => {
      const res = await send(base, 'POST', '/payouts/pay-1/approve', {});
      expect(res.status).toBe(400);
      expect(state.updates).toHaveLength(0);
    });
  });

  test('a normal positive payout still applies and deducts the balance', async () => {
    const state = freshState();
    primeDb(state);
    await withServer(async (base) => {
      const res = await send(base, 'POST', '/payouts/pay-1/approve', {});
      expect(res.status).toBe(200);
      expect(state.updates.map((u) => u.table)).toEqual(['referral_payouts', 'referral_promoters']);
    });
  });
});
