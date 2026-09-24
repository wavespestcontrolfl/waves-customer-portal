// Regression test for AUDIT r1-races-2.
//
// Before the fix, POST /trigger-upsell/:customerId had no in-flight guard
// and no prior-send check: two POSTs (a double-click, or a re-click after
// the "Upsell SMS sent!" toast) each independently passed every check and
// sent, texting the same marketing SMS twice. The route now claims a
// customer_interactions row under a per-customer advisory lock, inside a
// transaction, before rendering/sending — atomic across concurrent
// requests and persisted (survives a restart or a second app instance).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 't1'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
const mockFindBestUpsell = jest.fn();
jest.mock('../services/pricing-intelligence', () => ({ findBestUpsell: (...a) => mockFindBestUpsell(...a) }));
const mockSend = jest.fn();
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSend(...a) }));
jest.mock('../services/sms-template-renderer', () => ({
  renderRequiredSmsTemplate: async (key, vars) => `[${key}] Hi ${vars.first_name}, add ${vars.service_name || vars.next_tier}?`,
}));

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

const tables = { communications: [], upsell_rules_increments: 0, customer_interactions: [] };
// Serializes db.transaction bodies one at a time, the way a real Postgres
// pg_advisory_xact_lock would serialize two concurrent requests for the
// same customer — otherwise this in-memory fake has no lock of its own and
// both "transactions" could race past the recent-claim check.
let txQueue = Promise.resolve();
function setupDb(customerRow) {
  const build = (table) => {
    const q = {};
    for (const m of ['where', 'whereNull', 'select', 'orderBy', 'limit']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => {
      if (table === 'customer_interactions') {
        return tables.customer_interactions.find((r) => r.customer_id === customerRow.id) || null;
      }
      return customerRow; // serves both customers + notification_prefs
    });
    q.insert = jest.fn(async (row) => {
      if (table === 'communications') tables.communications.push(row);
      if (table === 'customer_interactions') tables.customer_interactions.push(row);
      return [1];
    });
    q.increment = jest.fn(async () => { tables.upsell_rules_increments += 1; return 1; });
    return q;
  };
  db.mockImplementation(build);
  db.transaction = jest.fn((cb) => {
    const trx = Object.assign(build, { raw: jest.fn((sql) => sql) });
    const run = txQueue.then(() => cb(trx));
    txQueue = run.catch(() => {});
    return run;
  });
}

function liveCustomer(id) {
  return { id, first_name: 'Pat', phone: '+15550000001', deleted_at: null, active: true, sms_enabled: true, marketing_offers: true, updated_at: '2026-09-01T00:00:00Z' };
}
const upsell = { type: 'cross_sell', service: 'Mosquito Control', category: 'mosquito', discountPct: 10, rule: { id: 7 } };

describe('audit r1-races-2: trigger-upsell double-send guard', () => {
  beforeEach(() => {
    db.mockReset(); mockFindBestUpsell.mockReset(); mockSend.mockReset();
    tables.communications.length = 0; tables.upsell_rules_increments = 0; tables.customer_interactions.length = 0;
    txQueue = Promise.resolve();
  });

  test('two sequential POSTs (re-click after toast): first sends, second is blocked — exactly one send', async () => {
    setupDb(liveCustomer('c-sequential'));
    mockFindBestUpsell.mockResolvedValue(upsell);
    mockSend.mockResolvedValue({ sent: true, sid: 'SM1' });
    let r1;
    let r2;
    let body2;
    await withServer(async (base) => {
      r1 = await fetch(`${base}/admin/pricing-strategy/trigger-upsell/c-sequential`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      r2 = await fetch(`${base}/admin/pricing-strategy/trigger-upsell/c-sequential`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      body2 = await r2.json();
    });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(409);
    expect(body2.code).toBe('UPSELL_ALREADY_SENT');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(tables.communications).toHaveLength(1);
    expect(tables.upsell_rules_increments).toBe(1);
  });

  test('two concurrent POSTs (double-click): one sends, one is blocked in-flight — exactly one send', async () => {
    setupDb(liveCustomer('c-concurrent'));
    mockFindBestUpsell.mockResolvedValue(upsell);
    mockSend.mockResolvedValue({ sent: true, sid: 'SM1' });
    let results;
    await withServer(async (base) => {
      const responses = await Promise.all([1, 2].map(() =>
        fetch(`${base}/admin/pricing-strategy/trigger-upsell/c-concurrent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })));
      results = await Promise.all(responses.map(async (r) => ({ status: r.status, body: await r.json() })));
    });
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    // Whichever guard catches the second request — the in-flight Set (a true
    // overlap) or the resend cooldown (the first request already finished) —
    // depends on exact event-loop/network timing between the two real HTTP
    // requests; either is a correct block, and the one thing that must never
    // vary is that only one SMS goes out.
    const blocked = results.find((r) => r.status === 409);
    expect(['UPSELL_SEND_IN_PROGRESS', 'UPSELL_ALREADY_SENT']).toContain(blocked.body.code);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(tables.communications).toHaveLength(1);
    expect(tables.upsell_rules_increments).toBe(1);
  });
});
