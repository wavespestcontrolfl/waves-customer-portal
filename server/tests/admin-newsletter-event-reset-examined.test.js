/**
 * An operator returning an event to pending (bulk "reset" or a PATCH to
 * adminStatus 'pending') is a decision to review it by hand, so the route
 * marks it examined (curated_at) and auto-curation never re-approves it.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    req.technician = { id: 'admin-1', role: 'admin', email: 'owner@example.com' };
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  newsletterGroupId: jest.fn(() => 101),
  unsubscribeUrl: jest.fn((token) => `https://example.com/unsubscribe/${token}`),
  sendOne: jest.fn(),
}));
jest.mock('../services/newsletter-sender', () => ({}));
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const adminNewsletterRouter = require('../routes/admin-newsletter');

const EVENT_UUID = '2b0fcf1c-2a8e-4d3e-9b5a-1f2e3d4c5b6a';

function mockEventsTable() {
  const updates = [];
  db.raw = jest.fn((sql) => ({ __raw: sql }));
  db.mockImplementation(() => {
    const q = {};
    ['where', 'whereIn', 'select'].forEach((method) => { q[method] = jest.fn(() => q); });
    q.first = jest.fn(async () => ({ id: EVENT_UUID, admin_status: 'approved' }));
    // update(patch, ['id']) is the bulk route's returning form.
    q.update = jest.fn(async (patch, returning) => { updates.push(patch); return returning ? [{ id: EVENT_UUID }] : 1; });
    q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
    return q;
  });
  return updates;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/newsletter', adminNewsletterRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('operator return-to-pending marks the event examined', () => {
  beforeEach(() => jest.clearAllMocks());

  test('bulk reset stamps curated_at (keeping an existing stamp)', async () => {
    const updates = mockEventsTable();
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/newsletter/events/bulk-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset', ids: [EVENT_UUID] }),
      });
      expect(res.status).toBe(200);
    });
    expect(updates[0].admin_status).toBe('pending');
    expect(updates[0].curated_at).toEqual({ __raw: 'COALESCE(curated_at, now())' });
    expect(updates[0].approved_via).toBe('operator_reset');
  });

  test('bulk approve does not touch curated_at', async () => {
    const updates = mockEventsTable();
    await withServer(async (baseUrl) => {
      await fetch(`${baseUrl}/admin/newsletter/events/bulk-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', ids: [EVENT_UUID] }),
      });
    });
    expect(updates[0].curated_at).toBeUndefined();
    expect(updates[0].approved_via).toBeUndefined();
  });

  test('PATCH to adminStatus pending stamps curated_at', async () => {
    const updates = mockEventsTable();
    await withServer(async (baseUrl) => {
      await fetch(`${baseUrl}/admin/newsletter/events/${EVENT_UUID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminStatus: 'pending' }),
      });
    });
    const statusWrite = updates.find((u) => u.admin_status === 'pending');
    expect(statusWrite.curated_at).toEqual({ __raw: 'COALESCE(curated_at, now())' });
    expect(statusWrite.approved_via).toBe('operator_reset');
  });
});

// Audit 2026-10-30 NEWS-04: an oversized selection was cut to 50 ids and the
// inbox still reported every selected event as updated.
describe('bulk event writes never process part of a request silently', () => {
  beforeEach(() => jest.clearAllMocks());

  const post = (baseUrl, path, body) => fetch(`${baseUrl}/admin/newsletter${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ids = (n) => Array.from({ length: n }, (_, i) => `2b0fcf1c-2a8e-4d3e-9b5a-${String(i).padStart(12, '0')}`);

  test('bulk action refuses more than 50 ids instead of updating the first 50', async () => {
    const updates = mockEventsTable();
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/events/bulk-action', { action: 'approve', ids: ids(51) });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/at most 50/);
    });
    expect(updates).toHaveLength(0);
  });

  test('bulk action returns the ids it actually updated', async () => {
    mockEventsTable();
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/events/bulk-action', { action: 'approve', ids: [EVENT_UUID, ids(1)[0]] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, updated: 1, updatedIds: [EVENT_UUID] });
    });
  });

  test('merge refuses more than 50 duplicates instead of merging the first 50', async () => {
    const updates = mockEventsTable();
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/events/merge', { primaryId: EVENT_UUID, duplicateIds: ids(51) });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/at most 50/);
    });
    expect(updates).toHaveLength(0);
  });
});
