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
jest.mock('../services/newsletter-subscribers', () => {
  // EMAIL_RE is a PRODUCTION export the import route validates with — take it
  // from the real module, never re-declare it in the mock.
  const actual = jest.requireActual('../services/newsletter-subscribers');
  return {
    EMAIL_RE: actual.EMAIL_RE,
    subscribeOrResubscribe: jest.fn(async ({ email }) => ({ action: 'created', subscriber: { id: `sub-${email}` } })),
    linkToCustomer: jest.fn(async () => {}),
    linkManyToCustomers: jest.fn(async () => 1),
  };
});
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const { subscribeOrResubscribe, linkManyToCustomers } = require('../services/newsletter-subscribers');
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

describe('POST /subscribers/import routes the bulk first-link through the canonical picker', () => {
  let rawCalls;
  beforeEach(() => {
    jest.clearAllMocks();
    rawCalls = [];
    db.raw = jest.fn(async (...args) => { rawCalls.push(args); return { rowCount: 0 }; });
    db.mockImplementation((table) => {
      if (table !== 'newsletter_subscribers') throw new Error(`Unexpected table ${table}`);
      const q = {};
      ['insert', 'onConflict', 'ignore'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.returning = jest.fn(async () => [{ id: 1 }, { id: 2 }]);
      return q;
    });
  });

  test('imported emails go to linkManyToCustomers (live-scoped) — no ad-hoc UPDATE ... FROM customers', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/newsletter/subscribers/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preConsented: true,
          subscribers: [{ email: ' Shared@Example.com ' }, { email: 'archived-only@example.com' }],
        }),
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual(expect.objectContaining({ inserted: 2 }));
    });

    expect(linkManyToCustomers).toHaveBeenCalledTimes(1);
    expect(linkManyToCustomers.mock.calls[0][0]).toEqual(['shared@example.com', 'archived-only@example.com']);
    // The unscoped bulk link is gone: nothing in this route may pin a profile
    // without the live-customer scope (an archived one would be silenced by
    // the sender's anti-join forever).
    expect(rawCalls).toEqual([]);
  });
});
