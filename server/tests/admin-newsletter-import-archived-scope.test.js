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
// The route is now a thin delegation to the reconciler (its own behavioral
// coverage — candidates, exclusions, writes — lives in
// newsletter-list-reconcile.test.js); mocked here to pin the ROUTE contract.
jest.mock('../services/newsletter-list-reconcile', () => ({ reconcileCustomers: jest.fn(async ({ dryRun }) => ({ dryRun })) }));

const express = require('express');
const db = require('../models/db');
const { reconcileCustomers } = require('../services/newsletter-list-reconcile');
const { linkManyToCustomers } = require('../services/newsletter-subscribers');
const adminNewsletterRouter = require('../routes/admin-newsletter');

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

// /subscribers/import-customers is now a thin, safety-preserving alias for
// the filtered reconciler (kept only so an existing no-body caller gets a
// safe dry-run reply instead of a 404); /subscribers/reconcile-customers is
// the same delegation under its own name. Both share one contract: a write
// needs BOTH dryRun:false AND confirm:'IMPORT' — anything else dry-runs.
describe.each([
  ['/subscribers/import-customers'],
  ['/subscribers/reconcile-customers'],
])('POST %s — default dry run, write needs dryRun:false AND confirm:"IMPORT"', (path) => {
  beforeEach(() => jest.clearAllMocks());

  test.each([
    ['no body', undefined, true],
    ['dryRun:false alone', { dryRun: false }, true],
    ['confirm:"IMPORT" alone', { confirm: 'IMPORT' }, true],
    ['dryRun:false + confirm:"IMPORT"', { dryRun: false, confirm: 'IMPORT' }, false],
  ])('%s -> reconcileCustomers({ dryRun: %s })', async (_label, body, expectedDryRun) => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/newsletter${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(res.status).toBe(200);
    });
    expect(reconcileCustomers).toHaveBeenCalledWith({ dryRun: expectedDryRun });
  });
});

// Held push-audit P1 (codex #5165): a confirmed write with per-customer
// errors must not read as a clean 200 — the route now answers 422 with an
// explicit success:false. Dry runs, and a clean write (no errors), are
// unaffected — pinned by the shared-contract test above (still asserts 200).
describe.each([
  ['/subscribers/import-customers'],
  ['/subscribers/reconcile-customers'],
])('POST %s — a confirmed write with errors answers success:false, non-2xx', (path) => {
  beforeEach(() => jest.clearAllMocks());

  test('a write with errors.length > 0 -> 422, success:false, errors preserved', async () => {
    reconcileCustomers.mockResolvedValue({
      dryRun: false, candidates: 2, importable: 1, imported: 1, excluded: {}, byCity: [], projected: { importable: 2, byCity: [] },
      errors: [{ customerId: 'c1', error: 'boom' }],
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/newsletter${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false, confirm: 'IMPORT' }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body).toMatchObject({ success: false, imported: 1, errors: [{ customerId: 'c1', error: 'boom' }] });
    });
  });

  test('a clean write (errors: []) still answers 200 with no success key', async () => {
    reconcileCustomers.mockResolvedValue({ dryRun: false, imported: 3, errors: [] });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/newsletter${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false, confirm: 'IMPORT' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBeUndefined();
      expect(body.imported).toBe(3);
    });
  });

  test('a dry run with errors.length > 0 is UNCHANGED — still 200, no success key (dry runs never gate on this)', async () => {
    reconcileCustomers.mockResolvedValue({ dryRun: true, importable: 1, errors: [{ customerId: 'c1', error: 'boom' }] });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/newsletter${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBeUndefined();
    });
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
