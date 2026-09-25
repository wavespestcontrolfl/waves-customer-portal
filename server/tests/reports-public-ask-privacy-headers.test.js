// AW-06 audit ("Additional gaps — Privacy headers"): both report ask
// endpoints must answer with Cache-Control: no-store and
// X-Robots-Tag: noindex, nofollow, applied as router-level middleware
// BEFORE the rate limiter. Global Helmet already sets Referrer-Policy in
// the real app — this suite (an isolated router, no Helmet mounted) only
// asserts the two headers this change actually adds.
//
// Also covers AW-06's project-report intent whitelist: a shipped chip may
// send an explicit `intent` and the server honors it before falling back to
// free-text routing.

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ sql }));
  return mock;
});
jest.mock('../config', () => ({
  s3: { bucket: 'test-bucket', region: 'us-east-1' },
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({})),
  GetObjectCommand: jest.fn(),
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));
jest.mock('../services/report-followup-appointment', () => ({
  findReportFollowupAppointment: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const { findReportFollowupAppointment } = require('../services/report-followup-appointment');
const reportsRouter = require('../routes/reports-public');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn(),
    limit: jest.fn().mockReturnThis(),
    insert: jest.fn().mockResolvedValue(1),
    update: jest.fn().mockResolvedValue(1),
    orderBy: jest.fn().mockReturnThis(),
    ...overrides,
  };
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/reports', reportsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
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

describe('Ask Waves privacy headers on both report ask endpoints (AW-06 additional gaps)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.fn.now.mockReturnValue('NOW');
    findReportFollowupAppointment.mockResolvedValue(null);
  });

  test('POST /reports/project/:token/ask sets Cache-Control: no-store and X-Robots-Tag: noindex, nofollow', async () => {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'project-1',
        customer_id: 'customer-1',
        report_token: '0123456789abcdef0123456789abcdef',
        project_type: 'rodent_trapping',
        status: 'sent',
        findings: JSON.stringify({ areas_treated: 'Exterior perimeter' }),
      }),
    });
    db.mockImplementation((table) => {
      if (table === 'projects as p' || table === 'projects') return projectRead;
      // router.param('token') suppression gate — no service report shares
      // this token, so it passes through untouched.
      if (table === 'service_records') return chain({ first: jest.fn().mockResolvedValue(undefined) });
      if (table === 'activity_log') return chain();
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/project/0123456789abcdef0123456789abcdef/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'What was treated?' }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      const body = await res.json();
      expect(body.answer).toContain('Exterior perimeter');
    });
  });

  test('POST /reports/:token/ask sets the same privacy headers, even on a 404 — the middleware runs before the handler', async () => {
    db.mockImplementation((table) => {
      // Both the router.param('token') gate and the route handler itself
      // query service_records; an absent row 404s the handler, but the
      // headers must already be set because the header middleware is
      // registered ahead of the rate limiter and the route.
      if (table === 'service_records') return chain({ first: jest.fn().mockResolvedValue(undefined) });
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/0123456789abcdef0123456789abcdef/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'What was applied today?' }),
      });
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    });
  });

  test('a whitelisted explicit intent on the project ask route short-circuits free-text routing', async () => {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'project-2',
        customer_id: 'customer-1',
        report_token: 'abcdefabcdefabcdefabcdefabcdefab',
        project_type: 'rodent_trapping',
        status: 'sent',
        findings: JSON.stringify({ areas_treated: 'Garage', findings_observed: 'Droppings near the garage.' }),
        recommendations: 'Seal the gap under the garage door.',
      }),
    });
    db.mockImplementation((table) => {
      if (table === 'projects as p' || table === 'projects') return projectRead;
      if (table === 'service_records') return chain({ first: jest.fn().mockResolvedValue(undefined) });
      if (table === 'activity_log') return chain();
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      // Free text alone would NOT route this to recommendations — the
      // explicit intent from the chip click still wins.
      const res = await fetch(`${baseUrl}/reports/project/abcdefabcdefabcdefabcdefabcdefab/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'tell me more', intent: 'recommendations' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.answer).toBe('Seal the gap under the garage door.');
    });
  });

  test('an unrecognized intent is ignored and falls back to free-text routing', async () => {
    const projectRead = chain({
      first: jest.fn().mockResolvedValue({
        id: 'project-2',
        customer_id: 'customer-1',
        report_token: 'abcdefabcdefabcdefabcdefabcdefab',
        project_type: 'rodent_trapping',
        status: 'sent',
        findings: JSON.stringify({ areas_treated: 'Garage' }),
      }),
    });
    db.mockImplementation((table) => {
      if (table === 'projects as p' || table === 'projects') return projectRead;
      if (table === 'service_records') return chain({ first: jest.fn().mockResolvedValue(undefined) });
      if (table === 'activity_log') return chain();
      throw new Error(`Unexpected table query: ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/reports/project/abcdefabcdefabcdefabcdefabcdefab/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'What was treated?', intent: 'not-a-real-intent' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.answer).toContain('Garage');
    });
  });
});
