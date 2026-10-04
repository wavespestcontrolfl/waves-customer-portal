/**
 * GET /api/admin/leads?no_customer=1 — the estimate tool's lookup lists only
 * leads with no customer record. The filter must run in SQL, on the page
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
  const passthrough = ['leftJoin', 'select', 'where', 'whereIn', 'whereRaw', 'whereNotIn', 'orderBy', 'limit', 'offset', 'count'];
  for (const name of passthrough) qb[name] = jest.fn(() => qb);
  qb.whereNull = jest.fn((col) => { log.push(col); return qb; });
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

test('no_customer=1 filters the page query and the count query in SQL', async () => {
  const { status, logs } = await list('status=open&no_customer=1&limit=8&search=Dana');
  expect(status).toBe(200);
  const filtered = logs.filter((log) => log.includes('leads.customer_id'));
  expect(filtered).toHaveLength(2);
});

test('without the parameter the list is unchanged', async () => {
  const { status, logs } = await list('status=open&search=Dana');
  expect(status).toBe(200);
  expect(logs.flat()).not.toContain('leads.customer_id');
});
