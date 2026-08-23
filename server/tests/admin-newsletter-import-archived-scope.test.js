process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => {
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => false),
  newsletterGroupId: jest.fn(() => null),
  unsubscribeUrl: jest.fn(() => ''),
  sendOne: jest.fn(),
}));
jest.mock('../services/newsletter-sender', () => ({}));
jest.mock('../services/event-freshness', () => ({ cityToZone: jest.fn(() => null) }));
jest.mock('../services/newsletter-subscribers', () => ({
  subscribeOrResubscribe: jest.fn(async ({ email }) => ({ action: 'created', subscriber: { id: `sub-${email}` } })),
}));
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const { subscribeOrResubscribe } = require('../services/newsletter-subscribers');
const adminNewsletterRouter = require('../routes/admin-newsletter');

// Archive (DELETE /api/admin/customers/:id) sets deleted_at only — active stays
// true. Rows mirror that: an archived customer is active AND deleted.
const CUSTOMERS = [
  { id: 1, email: 'live@example.com', first_name: 'L', last_name: 'One', city: null, active: true, deleted_at: null },
  { id: 2, email: 'archived@example.com', first_name: 'A', last_name: 'Two', city: null, active: true, deleted_at: new Date('2026-08-01') },
];

// Minimal knex stand-in that actually applies whereNull('deleted_at') so the
// test fails if the scope is dropped, not just if a method name changes.
function customersChain() {
  let rows = CUSTOMERS;
  const q = {};
  ['whereNotNull', 'where', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.whereNull = jest.fn((col) => {
    if (col === 'deleted_at' || col === 'customers.deleted_at') rows = rows.filter((r) => r.deleted_at == null);
    return q;
  });
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return q;
}

function subscribersChain() {
  const q = {};
  ['where', 'whereNull'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => null);
  q.update = jest.fn(async () => 0);
  return q;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/newsletter', adminNewsletterRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('POST /subscribers/import-customers archived-customer scope', () => {
  let customersQuery;
  beforeEach(() => {
    jest.clearAllMocks();
    customersQuery = null;
    db.mockImplementation((table) => {
      if (table === 'customers') { customersQuery = customersChain(); return customersQuery; }
      if (table === 'newsletter_subscribers') return subscribersChain();
      throw new Error(`Unexpected table ${table}`);
    });
  });

  test('scopes the candidate list on deleted_at and never subscribes an archived customer', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/newsletter/subscribers/import-customers`, { method: 'POST' });
      expect(res.status).toBe(200);
    });

    expect(customersQuery.whereNull).toHaveBeenCalledWith('deleted_at');
    expect(subscribeOrResubscribe).toHaveBeenCalledTimes(1);
    expect(subscribeOrResubscribe).toHaveBeenCalledWith(expect.objectContaining({ email: 'live@example.com' }));
    const emails = subscribeOrResubscribe.mock.calls.map(([args]) => args.email);
    expect(emails).not.toContain('archived@example.com');
  });
});
