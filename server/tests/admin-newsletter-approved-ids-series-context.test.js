/**
 * Codex P2 (2026-09-27), admin-newsletter.js:1917 "Select series context
 * before admitting recurring rows": GET /events/approved-ids didn't select
 * venue_name/city, so isSameSeriesSibling (newsletter-event-selection.js)
 * matched every same-title row regardless of venue/city — a recurring
 * identity's first-of-year admission could never tell two distinct
 * same-named series apart. Fixed by selecting the same series-context
 * columns the other planning paths (digest-plan, autopilot's buildDigestPlan,
 * draft loading) already select.
 *
 * Also covers the STRUCTURAL "one calendar-year pool per batch" consolidation
 * for this route: loadSharedYearPool is called once and threaded into both
 * filterRepeatedDateIdentities and filterPreviouslyFeaturedIdentities.
 *
 * newsletter-event-selection.js's filters and event-freshness.js's SQL/
 * eligibility gate are mocked to isolate the ROUTE's query shape and pool
 * wiring — the filters' own logic is covered in
 * newsletter-event-selection*.test.js.
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
jest.mock('../services/event-freshness', () => ({
  ...jest.requireActual('../services/event-freshness'),
  excludeRoutineRecurringFromQuery: jest.fn((query) => query),
  isEligibleForFreshDigest: jest.fn(() => true),
  dedupeDigestEvents: jest.fn((rows) => rows),
}));
jest.mock('../services/newsletter-event-selection', () => ({
  ...jest.requireActual('../services/newsletter-event-selection'),
  filterRepeatedDateIdentities: jest.fn(async (rows) => rows),
  filterPreviouslyFeaturedIdentities: jest.fn(async (rows) => rows),
  loadSharedYearPool: jest.fn(async () => []),
}));

const express = require('express');
const db = require('../models/db');
const { isEligibleForFreshDigest } = require('../services/event-freshness');
const {
  filterRepeatedDateIdentities,
  filterPreviouslyFeaturedIdentities,
  loadSharedYearPool,
} = require('../services/newsletter-event-selection');
const adminNewsletterRouter = require('../routes/admin-newsletter');

function buildEventsQuery(rows) {
  const selectCalls = [];
  const q = {};
  ['whereIn', 'whereNull', 'where', 'whereNotNull', 'whereNotIn', 'orderByRaw', 'limit'].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.select = jest.fn((...cols) => { selectCalls.push(cols); return q; });
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return { q, selectCalls };
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/newsletter', adminNewsletterRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
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

const FUTURE = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();

const APPROVED_EVENT = {
  id: 'evt-1',
  title: 'Riverside Trivia',
  admin_status: 'approved',
  start_at: FUTURE,
  end_at: null,
  event_url: 'https://events.example/riverside-trivia',
  event_type: 'recurring_series',
  recurrence_type: 'weekly',
  freshness_status: 'stale_recurring',
  times_featured: 0,
  last_featured_at: null,
  pulled_at: null,
  venue_name: 'Riverside Pub',
  city: 'sarasota',
};

describe('GET /events/approved-ids', () => {
  beforeEach(() => jest.clearAllMocks());

  test('selects venue_name and city (series context isSameSeriesSibling requires)', async () => {
    const { q, selectCalls } = buildEventsQuery([APPROVED_EVENT]);
    db.mockImplementation((table) => {
      if (table === 'events_raw as e') return q;
      throw new Error(`Unexpected table ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/newsletter/events/approved-ids`);
      expect(res.status).toBe(200);
    });

    const selectedColumns = selectCalls[0];
    expect(selectedColumns).toEqual(expect.arrayContaining(['e.venue_name', 'e.city']));
  });

  test('over-fetches the week before filtering, so dropped recurring repeats cannot crowd out valid events', async () => {
    const { q } = buildEventsQuery([APPROVED_EVENT]);
    db.mockImplementation((table) => {
      if (table === 'events_raw as e') return q;
      throw new Error(`Unexpected table ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/newsletter/events/approved-ids`);
      expect(res.status).toBe(200);
    });

    expect(q.limit).toHaveBeenCalledWith(500);
  });

  test('loads ONE shared calendar-year pool and threads it into both identity/history filters', async () => {
    const { q } = buildEventsQuery([APPROVED_EVENT]);
    db.mockImplementation((table) => {
      if (table === 'events_raw as e') return q;
      throw new Error(`Unexpected table ${table}`);
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/newsletter/events/approved-ids`);
      expect(res.status).toBe(200);
    });

    expect(loadSharedYearPool).toHaveBeenCalledTimes(1);
    expect(isEligibleForFreshDigest).toHaveBeenCalled();

    const repeatedOpts = filterRepeatedDateIdentities.mock.calls[0][1];
    const featuredOpts = filterPreviouslyFeaturedIdentities.mock.calls[0][1];
    expect(repeatedOpts.yearPool).toBe(featuredOpts.yearPool);
  });
});
