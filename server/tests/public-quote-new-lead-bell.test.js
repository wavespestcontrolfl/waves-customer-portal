/**
 * The quote wizard's new-lead bell marks the lead this run created (metadata.createdLead), which the new-lead re-alert
 * (new-lead-reminder.js intakeMarked) takes as the intake bell. Only the wizard's own row is marked: one this request
 * inserted, or the quote_wizard row its property-lookup stage minted. A voicemail or inbound-call lead the prefill
 * token attached the form to is a call lead already on file, so its bell is a fresh inquiry. This drives the whole
 * route with a database that answers `returning` as Postgres does: the written rows, only the columns asked for.
 */
jest.mock('../models/db', () => {
  const state = { leadRow: null, seq: 0 };
  const pick = (row, cols) => (Array.isArray(cols) ? Object.fromEntries(cols.filter((c) => c in row).map((c) => [c, row[c]])) : row);
  const makeBuilder = (table) => {
    const s = { op: null, rows: [], result: undefined };
    const builder = new Proxy(function builderTarget() {}, {
      get(_t, prop) {
        if (prop === 'then') return (resolve, reject) => Promise.resolve(s.result !== undefined ? s.result : []).then(resolve, reject);
        if (prop === 'catch') return (reject) => Promise.resolve(s.result !== undefined ? s.result : []).catch(reject);
        if (prop === 'first') return async () => null;
        if (prop === 'insert') {
          return (data) => {
            s.op = 'insert';
            s.rows = (Array.isArray(data) ? data : [data]).map((row) => ({ id: `id-${state.seq += 1}`, ...row }));
            s.result = s.rows.map((r) => ({ id: r.id }));
            return builder;
          };
        }
        if (prop === 'update') return () => { s.op = 'update'; s.result = 1; return builder; };
        if (prop === 'returning') {
          return (cols) => {
            if (s.op === 'insert') s.result = s.rows.map((r) => pick(r, cols));
            // The token path's claimed write on the run's lead row answers with that row.
            else if (s.op === 'update' && table === 'leads' && state.leadRow) s.result = [pick(state.leadRow, cols)];
            return builder;
          };
        }
        if (prop === 'del' || prop === 'delete') return async () => 0;
        if (prop === 'count') return () => { s.result = [{ count: '0' }]; return builder; };
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
  db.__state = state;
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
const { notifyAdmin } = require('../services/notification-service');

const LEAD = '7a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('POST /api/public/quote/calculate: the new-lead bell marks only the wizard\'s own lead', () => {
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
  beforeEach(() => {
    notifyAdmin.mockClear();
    db.__state.leadRow = null;
  });

  // One wizard run's quote step; `leadId` is the token its property-lookup stage handed the browser.
  const calculate = async (leadId) => {
    const res = await fetch(`${base}/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(leadId ? { leadId } : {}),
        firstName: 'Pat',
        lastName: 'Sample',
        email: 'pat.sample@example.com',
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
    expect(res.status).toBeLessThan(300);
    const bells = notifyAdmin.mock.calls.filter(([key]) => key === 'new_lead');
    expect(bells).toHaveLength(1);
    return bells[0][bells[0].length - 1].metadata;
  };
  const leadRow = (leadType) => ({
    id: LEAD, lead_source_id: null, lead_type: leadType, status: 'new', extracted_data: {}, created_at: new Date(),
  });

  test('a run with no token inserts its own lead and marks the bell', async () => {
    const meta = await calculate(null);
    expect(meta).toEqual({ leadId: expect.stringMatching(/^id-/), createdLead: true });
  });

  test('a run on the quote_wizard row its property-lookup stage minted marks the bell', async () => {
    db.__state.leadRow = leadRow('quote_wizard');
    expect(await calculate(LEAD)).toEqual({ leadId: LEAD, createdLead: true });
  });

  test.each(['voicemail', 'inbound_call'])('a form the prefill token attached to a call lead (%s) does not mark the bell', async (leadType) => {
    db.__state.leadRow = leadRow(leadType);
    expect(await calculate(LEAD)).toEqual({ leadId: LEAD, createdLead: false });
  });
});
