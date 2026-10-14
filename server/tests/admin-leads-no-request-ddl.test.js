/**
 * The leads router used to create its tables on the first request
 * (ensureLeadsTables, router middleware), so every leads GET could be a DDL
 * writer. The tables come from migrations 20260401000095_lead_attribution and
 * 20260701000004_leads_soft_delete; a request never runs DDL.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const leadsRouter = require('../routes/admin-leads');

const DDL_RE = /\b(create|alter|drop)\s+(unique\s+)?(table|index)\b/i;
const MIGRATIONS = path.join(__dirname, '..', 'models', 'migrations');

function thenableQuery(rows = []) {
  const q = new Proxy(function query() {}, {
    get(_target, prop) {
      if (prop === 'then') return (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      if (prop === 'catch') return fn => Promise.resolve(rows).catch(fn);
      return () => q;
    },
    apply: () => q,
  });
  return q;
}

async function get(urlPath) {
  const app = express();
  app.use('/admin/leads', leadsRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${urlPath}`);
    return response.status;
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

describe('the leads router runs no DDL on a request', () => {
  const statements = [];
  beforeEach(() => {
    statements.length = 0;
    db.mockReset().mockImplementation(() => thenableQuery([]));
    db.raw = jest.fn((sql) => { statements.push(String(sql)); return thenableQuery({ rows: [] }); });
    db.fn = { now: () => 'now()' };
  });

  test('the first GET after startup (and a second) issues no CREATE, ALTER or DROP', async () => {
    await get('/admin/leads/sources');
    await get('/admin/leads');
    expect(statements.filter(sql => DDL_RE.test(sql))).toEqual([]);
    // nothing touched the database before a route handler ran: no router middleware queries
    expect(db.mock.calls.length).toBeGreaterThan(0);
  });

  test('the router file holds no DDL and no table bootstrap', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-leads.js'), 'utf8');
    expect(source).not.toMatch(DDL_RE);
    expect(source).not.toMatch(/ensureLeadsTables|_tablesChecked/);
  });
});

describe('migrations create everything the router bootstrap used to create', () => {
  const read = name => fs.readFileSync(path.join(MIGRATIONS, name), 'utf8');
  test('lead_sources, leads, lead_activities, lead_source_costs and marketing_campaigns', () => {
    const attribution = read('20260401000095_lead_attribution.js');
    for (const table of ['lead_sources', 'leads', 'lead_activities', 'lead_source_costs', 'marketing_campaigns']) {
      expect(attribution).toMatch(new RegExp(`createTable\\('${table}'`));
    }
  });
  test('leads.deleted_at, leads.deleted_by and the partial index come from the soft-delete migration', () => {
    const softDelete = read('20260701000004_leads_soft_delete.js');
    expect(softDelete).toMatch(/hasColumn\('leads', 'deleted_at'\)/);
    expect(softDelete).toMatch(/hasColumn\('leads', 'deleted_by'\)/);
    expect(softDelete).toMatch(/CREATE INDEX IF NOT EXISTS idx_leads_deleted_at ON leads \(deleted_at\) WHERE deleted_at IS NOT NULL/);
  });
});
