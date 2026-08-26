// Admin pricing-strategy router: admin-only mount, no request-body message
// override on trigger-upsell, consent derived from stored notification_prefs,
// and explicit column allowlists on the PUT handlers.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
let mockRole = 'admin';
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 't1'; req.techRole = mockRole; next(); },
  requireAdmin: (req, res, next) => {
    if (req.techRole !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  },
}));
const mockFindBestUpsell = jest.fn();
jest.mock('../services/pricing-intelligence', () => ({ findBestUpsell: (...a) => mockFindBestUpsell(...a) }));
const mockSend = jest.fn();
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSend(...a) }));
const mockRender = jest.fn();
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: (...a) => mockRender(...a) }));

const express = require('express');
const db = require('../models/db');

let router;
beforeAll(() => { router = require('../routes/admin-pricing-strategy'); });

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/pricing-strategy', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return fn(base).finally(() => new Promise((r) => server.close(r)));
}

const LIVE = { id: 'c1', first_name: 'Test', phone: '+15550000001', deleted_at: null, active: true };
const PREFS = { customer_id: 'c1', sms_enabled: true, marketing_offers: true, updated_at: '2026-08-01T00:00:00.000Z' };

// Per-table mock: customers.first → customer, notification_prefs.first → prefs.
function setupDb({ customer = LIVE, prefs = PREFS, updateResult = [{ id: 'r1' }] } = {}) {
  const updateCalls = [];
  db.mockImplementation((table) => {
    const q = {};
    for (const m of ['where', 'whereNull', 'select', 'orderBy', 'limit', 'increment']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => (table === 'notification_prefs' ? prefs : customer));
    q.insert = jest.fn(async () => [1]);
    q.catch = jest.fn(async () => undefined);
    q.update = jest.fn((u) => { updateCalls.push({ table, updates: u }); return q; });
    q.returning = jest.fn(async () => updateResult);
    return q;
  });
  return updateCalls;
}

async function post(base, path, body) {
  return fetch(`${base}/admin/pricing-strategy${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
}
async function put(base, path, body) {
  return fetch(`${base}/admin/pricing-strategy${path}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
}

beforeEach(() => {
  mockRole = 'admin';
  db.mockReset(); mockFindBestUpsell.mockReset(); mockSend.mockReset(); mockRender.mockReset();
  mockRender.mockResolvedValue('TEMPLATE BODY');
  mockFindBestUpsell.mockResolvedValue({ type: 'tier_upgrade', nextTier: 'Gold', service: 'WaveGuard Gold', rule: null });
  mockSend.mockResolvedValue({ sent: true });
});

describe('admin-only mount', () => {
  test('tech role → 403 on trigger-upsell, no lookup / send', async () => {
    mockRole = 'tech';
    setupDb();
    await withServer(async (base) => {
      const res = await post(base, '/trigger-upsell/c1');
      expect(res.status).toBe(403);
    });
    expect(db).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('POST /trigger-upsell/:customerId', () => {
  test('body.message is ignored — the rendered template is what gets sent', async () => {
    setupDb();
    await withServer(async (base) => {
      const res = await post(base, '/trigger-upsell/c1', { message: 'ATTACKER TEXT' });
      expect(res.status).toBe(200);
      expect((await res.json()).messageSent).toBe('TEMPLATE BODY');
    });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0].body).toBe('TEMPLATE BODY');
  });

  test('consentBasis comes from stored customer marketing preferences', async () => {
    setupDb();
    await withServer(async (base) => {
      expect((await post(base, '/trigger-upsell/c1')).status).toBe(200);
    });
    const args = mockSend.mock.calls[0][0];
    expect(args.purpose).toBe('marketing');
    expect(args.consentBasis).toEqual({
      status: 'opted_in',
      source: 'customer_marketing_preferences',
      capturedAt: '2026-08-01T00:00:00.000Z',
    });
  });

  test.each([
    ['no prefs row', null],
    ['sms disabled', { ...PREFS, sms_enabled: false }],
    ['marketing_offers off', { ...PREFS, marketing_offers: false }],
    ['seasonal-only opt-in (marketing_offers NULL) — toggles are independent', { ...PREFS, marketing_offers: null, seasonal_tips: true }],
  ])('%s → 422 NO_MARKETING_CONSENT before any send', async (_label, prefs) => {
    setupDb({ prefs });
    await withServer(async (base) => {
      const res = await post(base, '/trigger-upsell/c1');
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('NO_MARKETING_CONSENT');
    });
    expect(mockFindBestUpsell).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('PUT /upsell-rules/:id allowlist', () => {
  test('non-numeric discount_pct → 400, no update', async () => {
    const calls = setupDb();
    await withServer(async (base) => {
      const res = await put(base, '/upsell-rules/r1', { discount_pct: 'abc' });
      expect(res.status).toBe(400);
    });
    expect(calls).toHaveLength(0);
  });

  test('out-of-range discount_pct → 400', async () => {
    const calls = setupDb();
    await withServer(async (base) => {
      expect((await put(base, '/upsell-rules/r1', { discount_pct: 150 })).status).toBe(400);
    });
    expect(calls).toHaveLength(0);
  });

  test('unknown / protected columns are dropped', async () => {
    const calls = setupDb();
    await withServer(async (base) => {
      const res = await put(base, '/upsell-rules/r1', {
        name: 'Rule', discount_pct: '12.5', times_triggered: 999, times_converted: 999,
        id: 'other', created_at: '2020-01-01', bogus: 'x',
      });
      expect(res.status).toBe(200);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].updates).toEqual({ name: 'Rule', discount_pct: 12.5 });
  });

  test('only unknown columns → 400, no update', async () => {
    const calls = setupDb();
    await withServer(async (base) => {
      expect((await put(base, '/upsell-rules/r1', { times_triggered: 5 })).status).toBe(400);
    });
    expect(calls).toHaveLength(0);
  });
});

describe('PUT /offers/:id allowlist', () => {
  test('unknown / protected columns are dropped, updated_at is set', async () => {
    const calls = setupDb();
    await withServer(async (base) => {
      const res = await put(base, '/offers/o1', { name: 'Offer', id: 'other', created_at: '2020-01-01', bogus: 1 });
      expect(res.status).toBe(200);
    });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].updates).sort()).toEqual(['name', 'updated_at']);
  });

  test('only unknown / protected columns → 400, no update (updated_at alone is not an update)', async () => {
    const calls = setupDb();
    await withServer(async (base) => {
      expect((await put(base, '/offers/o1', { id: 'other', times_triggered: 5, bogus: 1 })).status).toBe(400);
    });
    expect(calls).toHaveLength(0);
  });
});
