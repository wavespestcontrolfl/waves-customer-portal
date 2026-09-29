/**
 * Neutral review asks (owner ruling 2026-09-29): every score on /rate/:token
 * is offered the SAME Google review URL, and going to Google is always the
 * customer's own click — the server never returns a redirect for one score
 * band only. Low scores still get the private feedback path and the same
 * office / health alerts. The AI review writer route is gone.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'neutral-asks-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gates: {}, isEnabled: jest.fn(() => false) }));
jest.mock('../services/review-request', () => ({
  REVIEW_TOKEN_RE: /^[A-Za-z0-9_-]{32,64}$/,
  stopReviewSequence: jest.fn(async () => {}),
}));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({})) }));
jest.mock('../services/referral-invite-email', () => ({ sendReferralInviteEmail: jest.fn(async () => {}) }));
jest.mock('../services/workflows/referral-nudge', () => ({ triggerAfterPositiveReview: jest.fn(async () => {}) }));
jest.mock('../services/customer-health', () => ({ scoreCustomer: jest.fn(async () => {}) }));
jest.mock('../services/health-alerts', () => ({ generateAlerts: jest.fn(async () => {}) }));
jest.mock('../services/customer-contact', () => ({ getServiceContact: jest.fn(() => ({ name: 'Pat' })) }));
jest.mock('../models/db', () => {
  const state = { request: null, claimed: 1, activity: [] };
  const fn = jest.fn((table) => {
    const q = {};
    for (const m of ['where', 'whereNull', 'orderBy', 'limit', 'select']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => {
      if (table === 'review_requests') return state.request;
      if (table === 'customers') return { id: 'cust-1', first_name: 'Pat', last_name: 'Lee' };
      return null;
    });
    q.update = jest.fn(async () => (table === 'review_requests' ? state.claimed : 1));
    q.insert = jest.fn(async (row) => { state.activity.push([table, row]); return [1]; });
    return q;
  });
  fn.state = state;
  fn.fn = { now: jest.fn(() => 'now()') };
  fn.raw = jest.fn((s) => s);
  return fn;
});

const express = require('express');
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const healthAlerts = require('../services/health-alerts');
const { WAVES_LOCATIONS } = require('../config/locations');

const loc = WAVES_LOCATIONS[0];
const TOKEN = 'ab'.repeat(32);
let server; let base;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/rate', require('../routes/review-gate'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
  db.state.claimed = 1;
  db.state.activity = [];
  db.state.request = {
    id: 'rr-1', customer_id: 'cust-1', location_id: loc.id, status: 'sent',
    service_type: 'Pest Control', expires_at: null, sequence_id: null,
  };
});

const post = (path, body) => fetch(`${base}/api/rate/${TOKEN}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const flush = () => new Promise((r) => setImmediate(r));

describe('POST /:token/submit — the same Google URL for every score', () => {
  test.each([
    [10, 'promoter'],
    [8, 'promoter'],
    [7, 'passive'],
    [4, 'passive'],
    [3, 'detractor'],
    [1, 'detractor'],
  ])('score %i (%s) carries googleReviewUrl and never an auto-redirect', async (score, category) => {
    const res = await post('/submit', { score, feedback: 'note', highlights: [] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.category).toBe(category);
    expect(body.googleReviewUrl).toBe(loc.googleReviewUrl);
    expect(body).not.toHaveProperty('redirect');
    // No band-specific Google wording in the API message either.
    expect(body.message).not.toMatch(/google/i);
  });

  test('a detractor still fires the office SMS and the health alert', async () => {
    const res = await post('/submit', { score: 2, feedback: 'Missed the back yard', highlights: [] });
    expect(res.status).toBe(200);
    await flush();
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    const [, text, opts] = TwilioService.sendSMS.mock.calls[0];
    expect(text).toMatch(/Low NPS alert: Pat Lee rated 2\/10/);
    expect(text).toMatch(/Missed the back yard/);
    expect(opts).toEqual({ messageType: 'internal_alert' });
    expect(healthAlerts.generateAlerts).toHaveBeenCalledWith('cust-1', expect.objectContaining({ churnRisk: 'high' }));
  });

  test.each([5, 9])('score %i does not fire the low-score alerts', async (score) => {
    await post('/submit', { score, feedback: '', highlights: [] });
    await flush();
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(healthAlerts.generateAlerts).not.toHaveBeenCalled();
  });

  test('finality is unchanged: an already-submitted request is a 409 with no Google URL', async () => {
    db.state.request = { ...db.state.request, status: 'submitted', rated_at: new Date() };
    const res = await post('/submit', { score: 9, feedback: '', highlights: [] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Feedback already submitted' });
  });
});

describe('GET /:token and the removed AI writer', () => {
  test('the page data carries the Google URL for every score (it is score-independent) and no writer-only fields', async () => {
    const res = await fetch(`${base}/api/rate/${TOKEN}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.googleReviewUrl).toBe(loc.googleReviewUrl);
    expect(body).not.toHaveProperty('serviceType');
    expect(body).not.toHaveProperty('hasServiceType');
  });

  test('POST /:token/generate-review no longer exists', async () => {
    const res = await post('/generate-review', { services: ['Pest Control'], highlights: [], personalNote: '' });
    expect(res.status).toBe(404);
  });

  test('nothing in the router or the public allowlist still names the writer or its lane', () => {
    const fs = require('fs');
    const path = require('path');
    const routerSrc = fs.readFileSync(path.join(__dirname, '../routes/review-gate.js'), 'utf8');
    expect(routerSrc).not.toMatch(/generate-review|generated_review_text|review_gate_text|dispatchWithFallback/);
    const allow = fs.readFileSync(path.join(__dirname, '../config/public-route-allowlist.json'), 'utf8');
    expect(allow).not.toMatch(/generate-review/);
    const { LANES, LANE_AREA, LANE_DESCRIBE } = require('../services/model-switchboard');
    expect(LANES.length).toBeGreaterThan(10);
    expect(JSON.stringify([LANES, LANE_AREA, LANE_DESCRIBE])).not.toMatch(/review_gate_text/);
    expect(fs.readFileSync(path.join(__dirname, '../services/agent-control/lane-policies.js'), 'utf8')).not.toMatch(/review_gate_text/);
  });
});
