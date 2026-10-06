/**
 * GET /api/admin/leads?estimate_attachable=1 — the estimate tool's lookup lists
 * only leads a new estimate can attach to: no customer record, no estimate
 * yet, and a phone or an email. The filter must run in SQL, on the page
 * query AND the count query, so a page of customer-linked matches cannot hide
 * an eligible lead behind LIMIT.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technician = { first_name: 'Ava' }; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const leadsRouter = require('../routes/admin-leads');

// Chainable knex stand-in: records whereNull columns, resolves rows / a count.
function chain(result, log) {
  const qb = {};
  const passthrough = ['leftJoin', 'select', 'where', 'whereIn', 'whereNotIn', 'orderBy', 'limit', 'offset', 'count'];
  for (const name of passthrough) qb[name] = jest.fn(() => qb);
  qb.whereNull = jest.fn((col) => { log.push(col); return qb; });
  qb.whereRaw = jest.fn((sql) => { log.push(sql); return qb; });
  qb.modify = jest.fn(() => qb);
  qb.first = jest.fn(async () => ({ count: '0' }));
  qb.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return qb;
}

async function list(query) {
  const logs = [];
  db.mockImplementation(() => { const log = []; logs.push(log); return chain([], log); });
  db.raw = jest.fn((sql) => sql);
  const app = express();
  app.use('/admin/leads', leadsRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/leads?${query}`);
    return { status: res.status, logs };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('estimate_attachable=1 filters the page query and the count query in SQL', async () => {
  const { status, logs } = await list('status=open&estimate_attachable=1&limit=8&search=Dana');
  expect(status).toBe(200);
  const filtered = logs.filter((log) => log.includes('leads.customer_id'));
  expect(filtered).toHaveLength(2);
  for (const log of filtered) {
    expect(log).toContain('leads.estimate_id');
    expect(log.some((entry) => /leads\.phone/.test(entry) && /leads\.email/.test(entry))).toBe(true);
  }
});

test('without the parameter the list is unchanged', async () => {
  const { status, logs } = await list('status=open&search=Dana');
  expect(status).toBe(200);
  expect(logs.flat()).not.toContain('leads.customer_id');
  expect(logs.flat()).not.toContain('leads.estimate_id');
});
