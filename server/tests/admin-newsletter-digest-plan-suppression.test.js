/**
 * Codex P2 (2026-09-27), admin-newsletter.js:1964 "Derive planner suppression
 * from the filtered candidates": POST /events/digest-plan built `suppressed`
 * by re-calling isEligibleForFreshDigest(r) on the RAW row (no reference, and
 * none of the __recurringFirstOfYear / __recurrenceOccurrenceCount markers
 * filterRepeatedDateIdentities had just stamped onto the SAME identity a few
 * lines earlier) — so a recurring identity the pipeline just ADMITTED into
 * `eligible`/`scored` still showed up in `suppressed` too: an admitted event
 * rendered as suppressed in the planner UI.
 *
 * Fixed: suppression is now the plain set difference between the raw
 * candidate rows and the ids that survived into `eligible`.
 *
 * newsletter-event-selection.js's identity filters are mocked (their own
 * logic is covered elsewhere) so this isolates the ROUTE's suppression
 * derivation. event-freshness.js's isEligibleForFreshDigest is the REAL
 * function — the test relies on its actual stale_recurring / marker behavior
 * to reproduce the exact double-counting bug.
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
  // Bypass the real SQL-shaping helper (it needs a real knex query builder
  // API) — the route's own JS-side suppression math is what's under test.
  excludeRoutineRecurringFromQuery: jest.fn((query) => query),
}));
jest.mock('../services/newsletter-event-selection', () => ({
  ...jest.requireActual('../services/newsletter-event-selection'),
  filterRepeatedDateIdentities: jest.fn(),
  filterPreviouslyFeaturedIdentities: jest.fn(async (rows) => rows),
  loadSharedYearPool: jest.fn(async () => []),
}));

const express = require('express');
const db = require('../models/db');
const {
  filterRepeatedDateIdentities,
} = require('../services/newsletter-event-selection');
const adminNewsletterRouter = require('../routes/admin-newsletter');

function buildEventsQuery(rows) {
  const q = {};
  ['leftJoin', 'whereIn', 'whereNull', 'where', 'whereNotNull', 'whereNotIn', 'orderByRaw', 'select'].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return q;
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

const FAR_FUTURE = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

// A recurring identity filterRepeatedDateIdentities will stamp as first-of-year
// (routine + stale_recurring — real isEligibleForFreshDigest only admits this
// through the __recurringFirstOfYear marker, which is exactly what makes this
// fixture reproduce the original double-counting bug).
const RECURRING_ADMITTED = {
  id: 'admitted-recurring',
  title: 'Weekly Trivia Night',
  description: 'Trivia every Tuesday.',
  start_at: FAR_FUTURE,
  end_at: null,
  venue_name: 'The Blind Tiger',
  city: 'sarasota',
  event_url: 'https://events.example/trivia',
  event_type: 'recurring_series',
  recurrence_type: 'weekly',
  freshness_status: 'stale_recurring',
  freshness_score: 60,
  admin_status: 'approved',
  times_featured: 0,
  last_featured_at: null,
  pulled_at: null,
  region_zone: null,
  family_friendly: null,
  is_free: null,
  source_name: 'Test Feed',
  source_priority_tier: 1,
};

// A genuinely ineligible row (no event_url) — suppressed under BOTH the old
// and new logic, so it doesn't by itself prove anything; it's here to prove
// suppression still works at all, not just that it's now empty.
const GENUINELY_INELIGIBLE = {
  ...RECURRING_ADMITTED,
  id: 'genuinely-ineligible',
  title: 'Old Listing With No Link',
  event_url: null,
};

describe('POST /events/digest-plan suppression reflects the FILTERED pipeline, not a re-check of raw rows', () => {
  beforeEach(() => jest.clearAllMocks());

  test('an event admitted via __recurringFirstOfYear never also appears in suppressed', async () => {
    const rawRows = [RECURRING_ADMITTED, GENUINELY_INELIGIBLE];
    db.mockImplementation((table) => {
      if (table === 'events_raw as e') return buildEventsQuery(rawRows);
      throw new Error(`Unexpected table ${table}`);
    });
    // Planning admits ONLY the recurring identity, stamping the pool-verified
    // marker — exactly what a real filterRepeatedDateIdentities call would do
    // for a continuity-proven first-of-year occurrence.
    filterRepeatedDateIdentities.mockImplementation(async (rows) => rows.map((r) => (
      r.id === RECURRING_ADMITTED.id
        ? { ...r, __recurringFirstOfYear: true, __recurrenceOccurrenceCount: 2 }
        : r
    )));

    let body;
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/newsletter/events/digest-plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      body = await res.json();
    });

    const eligibleIds = [...body.sections.fresh_this_week, ...body.sections.just_starting,
      ...body.sections.weekend_picks, ...body.sections.family_or_low_key_pick,
      ...body.sections.road_trip_pick].map((e) => e.id);
    // The admitted recurring row must be assigned somewhere in the lineup...
    expect(eligibleIds).toContain(RECURRING_ADMITTED.id);
    // ...and — this is the actual regression — must NEVER also show up as
    // suppressed. Before the fix it did, because suppressed re-ran
    // isEligibleForFreshDigest on the UNSTAMPED raw row.
    expect(body.suppressed.map((s) => s.id)).not.toContain(RECURRING_ADMITTED.id);
    // The genuinely ineligible row is still correctly suppressed.
    expect(body.suppressed.map((s) => s.id)).toContain(GENUINELY_INELIGIBLE.id);
  });
});
