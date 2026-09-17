/**
 * POST /admin/review-requests/tech-trigger — the deployed native tech app's
 * "ask for a review" endpoint. `sent` and the accompanying copy must never
 * promise more than sendSMS actually queued (codex #4141 r3 P2 family).
 *
 * Codex P1 (this suite): an uncertain provider handoff or a claim another
 * sender already holds leaves the row exactly as the in-flight attempt found
 * it — no scheduled_for — so processScheduled can never select it. The route
 * used to fall through to the generic deferred copy and tell the operator
 * the text "will go out automatically" regardless. ReviewService.create is
 * mocked so this suite exercises only the route's own copy selection, not
 * sendSMS internals (covered in review-sequences.test.js).
 */

jest.mock('../models/db', () => {
  const fn = jest.fn();
  return fn;
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const role = token === 'admin' ? 'admin' : token === 'tech' ? 'technician' : null;
    if (!role) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = { id: `${role}-1`, role };
    req.technicianId = `${role}-1`;
    req.techRole = role;
    return next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (req, res, next) => (
    req.techRole !== 'admin'
      ? res.status(403).json({ error: 'Admin access required' })
      : next()
  ),
}));
jest.mock('../services/review-request', () => ({
  create: jest.fn(),
  unshortenedReviewUrl: jest.fn((token) => `https://portal.test/rate/${token}`),
}));

const express = require('express');
const db = require('../models/db');
const ReviewService = require('../services/review-request');
const reviewRequestsRouter = require('../routes/admin-review-requests');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/review-requests', reviewRequestsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function techTrigger(baseUrl, body) {
  return fetch(`${baseUrl}/admin/review-requests/tech-trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tech' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation((table) => {
    if (table === 'service_records') {
      return { where: jest.fn(() => ({ first: jest.fn(async () => ({ id: 'sr-1', customer_id: 'cust-1' })) })) };
    }
    throw new Error(`unexpected table ${table}`);
  });
});

test('an uncertain provider handoff is reported unsent with no "will go out automatically" promise', async () => {
  ReviewService.create.mockResolvedValueOnce({
    id: 'rr-1', token: 'tok-1',
    sendOutcome: { sent: false, uncertain: true, reason: 'provider_uncertain', nextAllowedAt: null },
  });
  await withServer(async (baseUrl) => {
    const res = await techTrigger(baseUrl, { serviceRecordId: 'sr-1' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.sent).toBe(false);
    expect(body.uncertain).toBe(true);
    expect(body.deferred).toBeUndefined();
    expect(body.message).not.toMatch(/will go out automatically/i);
    expect(body.message).toMatch(/could not be confirmed/i);
  });
});

test('a claim already held by another sender is reported unsent with no "will go out automatically" promise', async () => {
  ReviewService.create.mockResolvedValueOnce({
    id: 'rr-2', token: 'tok-2',
    sendOutcome: { sent: false, uncertain: true, reason: 'review_claim_lost', nextAllowedAt: null },
  });
  await withServer(async (baseUrl) => {
    const res = await techTrigger(baseUrl, { serviceRecordId: 'sr-1' });
    const body = await res.json();
    expect(body.sent).toBe(false);
    expect(body.uncertain).toBe(true);
    expect(body.message).not.toMatch(/will go out automatically/i);
  });
});

test('a real cron-owned deferral still tells the tech the text will go out automatically', async () => {
  const nextAllowedAt = new Date(Date.now() + 5 * 60000).toISOString();
  ReviewService.create.mockResolvedValueOnce({
    id: 'rr-3', token: 'tok-3',
    sendOutcome: { sent: false, deferred: 'provider_retry', nextAllowedAt },
  });
  await withServer(async (baseUrl) => {
    const res = await techTrigger(baseUrl, { serviceRecordId: 'sr-1' });
    const body = await res.json();
    expect(body.sent).toBe(false);
    expect(body.uncertain).toBeUndefined();
    expect(body.deferred).toBe('provider_retry');
    expect(body.nextAllowedAt).toBe(nextAllowedAt);
    expect(body.message).toMatch(/will go out automatically/i);
  });
});

test('a delivered send is reported sent, with no unsent fields at all', async () => {
  ReviewService.create.mockResolvedValueOnce({ id: 'rr-4', token: 'tok-4' });
  await withServer(async (baseUrl) => {
    const res = await techTrigger(baseUrl, { serviceRecordId: 'sr-1' });
    const body = await res.json();
    expect(body.sent).toBe(true);
    expect(body.uncertain).toBeUndefined();
    expect(body.deferred).toBeUndefined();
    expect(body.message).toBeUndefined();
  });
});
