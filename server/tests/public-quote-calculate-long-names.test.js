/**
 * 2026-11-05 new-customer walk: a 300-character first name answered 500 from
 * POST /api/public/quote/calculate (leads.first_name is varchar 255). Codex then
 * showed the same name reaching customer_accounts / customers (varchar 50) and
 * estimates.customer_name (varchar 100). This drives the whole route with a
 * recording database and checks every captured write fits its column.
 */
jest.mock('../models/db', () => {
  const recorded = [];
  let seq = 0;
  const makeBuilder = (table) => {
    const state = { table };
    const builder = new Proxy(function builderTarget() {}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve, reject) => Promise.resolve(state.result !== undefined ? state.result : []).then(resolve, reject);
        }
        if (prop === 'catch') return (reject) => Promise.resolve(state.result !== undefined ? state.result : []).catch(reject);
        if (prop === 'first') return async () => null;
        if (prop === 'insert') {
          return (data) => {
            const rows = Array.isArray(data) ? data : [data];
            rows.forEach((row) => recorded.push({ op: 'insert', table, row }));
            state.result = rows.map(() => ({ id: `id-${seq += 1}` }));
            return builder;
          };
        }
        if (prop === 'update') {
          return (data) => { recorded.push({ op: 'update', table, row: data }); state.result = 1; return builder; };
        }
        if (prop === 'del' || prop === 'delete') return async () => 0;
        if (prop === 'count') return () => { state.result = [{ count: '0' }]; return builder; };
        if (prop === 'returning') return () => builder;
        return () => builder;
      },
      apply() { return builder; },
    });
    return builder;
  };
  const db = jest.fn((table) => makeBuilder(table));
  db.raw = jest.fn((sql) => ({ toSQL: () => sql, sql }));
  db.fn = { now: () => new Date(), uuid: () => 'uuid' };
  db.transaction = jest.fn(async (cb) => cb(db));
  db.schema = { hasTable: async () => true, hasColumn: async () => true };
  db.__recorded = recorded;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: false })) }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => false), sendOne: jest.fn(async () => ({})), newsletterGroupId: () => null, serviceGroupId: () => null,
}));
jest.mock('../services/newsletter-subscribers', () => ({ subscribeOrResubscribe: jest.fn(async () => ({ action: 'noop' })) }));
jest.mock('../services/automation-runner', () => ({ enrollCustomer: jest.fn(async () => ({ enrolled: false })) }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (u) => u) }));

const express = require('express');
const db = require('../models/db');

const LIMITS = {
  leads: { first_name: 255, last_name: 255 },
  customers: { first_name: 50, last_name: 50 },
  customer_accounts: { first_name: 50, last_name: 50 },
  estimates: { customer_name: 100 },
};

const chars = (s) => Array.from(String(s)).length;

describe('POST /api/public/quote/calculate with very long names', () => {
  let server;
  let base;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use('/api/public/quote', require('../routes/public-quote'));
     
    app.use((err, req, res, next) => res.status(500).json({ error: 'boom' }));
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api/public/quote`; done(); });
  });
  afterAll((done) => { server.closeAllConnections(); server.close(done); });

  test('answers without a 500 and every captured write fits its column', async () => {
    const res = await fetch(`${base}/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'a'.repeat(299) + '😀' + 'tail',
        lastName: 'b'.repeat(120),
        email: 'long.name@example.com',
        phone: '9415550142',
        address: '123 Sample St, Parrish, FL 34219',
        city: 'Parrish',
        zip: '34219',
        homeSqFt: 1800,
        lotSqFt: 8000,
        stories: 1,
        services: { pest: { frequency: 'quarterly' } },
      }),
    });
    const bodyText = await res.text();
    expect(res.status).toBeLessThan(300);
    expect(bodyText).not.toMatch(/Something went wrong/);

    const captured = db.__recorded;
    const tablesSeen = new Set(captured.map((w) => w.table));
    // The route reached every write the walk's name has to survive.
    expect([...tablesSeen]).toEqual(expect.arrayContaining(['leads', 'customer_accounts', 'customers', 'estimates']));
    for (const w of captured) {
      const limits = LIMITS[w.table];
      if (!limits) continue;
      for (const [col, max] of Object.entries(limits)) {
        const value = w.row[col];
        if (typeof value === 'string') expect({ table: w.table, col, fits: chars(value) <= max }).toEqual({ table: w.table, col, fits: true });
      }
    }
    // The names that did land are the cut values, not the raw 300 characters.
    const leadInsert = captured.find((w) => w.table === 'leads' && w.op === 'insert');
    expect(chars(leadInsert.row.first_name)).toBe(50);
    expect(chars(leadInsert.row.last_name)).toBe(50);
    expect(leadInsert.row.first_name).not.toMatch(/[\uD800-\uDFFF]$/);
  });
});
