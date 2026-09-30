/**
 * The 1-10 rating is retired (owner ruling 2026-09-29). /api/rate/:token is a
 * thank-you page with ONE tap to Google: the page GET returns `reviewUrl`
 * (always the tracked /go link, null for a customer who already reviewed) and nothing
 * else on this router writes a rating. The score / submit / AI-writer routes
 * are gone and so are the low-score office alerts that only fired from them.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'neutral-asks-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gates: {}, isEnabled: jest.fn(() => false) }));
jest.mock('../services/review-request', () => ({
  REVIEW_TOKEN_RE: /^[A-Za-z0-9_-]{32,64}$/,
  stopFutureAsks: jest.fn(async () => {}),
}));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({})) }));
jest.mock('../services/customer-contact', () => ({ getServiceContact: jest.fn(() => ({ name: 'Pat' })) }));
jest.mock('../models/db', () => {
  const state = { request: null, customer: null };
  const fn = jest.fn((table) => {
    const q = {};
    for (const m of ['where', 'whereNull', 'orderBy', 'limit', 'select']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => {
      if (table === 'review_requests') return state.request;
      if (table === 'customers') return state.customer;
      return null;
    });
    q.update = jest.fn(async () => 1);
    return q;
  });
  fn.state = state;
  return fn;
});

const express = require('express');
const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const TwilioService = require('../services/twilio');
const { WAVES_LOCATIONS } = require('../config/locations');
const { publicPortalUrl } = require('../utils/portal-url');

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
  isEnabled.mockImplementation(() => false);
  db.state.customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Lee', has_left_google_review: false };
  db.state.request = {
    id: 'rr-1', token: TOKEN, customer_id: 'cust-1', location_id: loc.id, status: 'sent',
    service_type: 'Pest Control', expires_at: null, technician_id: null,
  };
});

const getPage = () => fetch(`${base}/api/rate/${TOKEN}`);
const post = (path, body = {}) => fetch(`${base}/api/rate/${TOKEN}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('GET /:token — thank-you data and the one Google URL', () => {
  test.each([true, false])('gate %s: reviewUrl is ALWAYS the tracked /go link; no rating fields', async (on) => {
    isEnabled.mockImplementation((k) => (k === 'reviewDirectLink' ? on : k === 'reviewSequences'));
    const body = await (await getPage()).json();
    expect(body.reviewUrl).toBe(`${publicPortalUrl()}/api/rate/${TOKEN}/go`);
    expect(body).not.toHaveProperty('googleReviewUrl');
    expect(body).not.toHaveProperty('serviceType');
  });

  test('a customer already marked as a reviewer gets no button (reviewUrl null)', async () => {
    db.state.customer.has_left_google_review = true;
    const res = await getPage();
    expect(res.status).toBe(200);
    expect((await res.json()).reviewUrl).toBeNull();
  });

  test.each([
    ['rated_at set (legacy rating)', { rated_at: new Date() }],
    ['status submitted', { status: 'submitted' }],
    ['status reviewed', { status: 'reviewed' }],
    ['status rated', { status: 'rated' }],
  ])('finalized (%s): alreadySubmitted, no reviewUrl', async (_n, patch) => {
    db.state.request = { ...db.state.request, ...patch };
    const body = await (await getPage()).json();
    expect(body.alreadySubmitted).toBe(true);
    expect(body).not.toHaveProperty('reviewUrl');
  });

  test('expired and unknown links keep their 410 / 404', async () => {
    db.state.request = { ...db.state.request, expires_at: '2020-01-01T00:00:00.000Z' };
    expect((await getPage()).status).toBe(410);
    db.state.request = null;
    expect((await getPage()).status).toBe(404);
  });
});

describe('the rating, feedback and AI-writer endpoints are gone', () => {
  test.each(['/score', '/submit', '/generate-review'])('POST %s → 404 and nothing is written or alerted', async (path) => {
    const res = await post(path, { score: 2, feedback: 'bad', highlights: [] });
    expect(res.status).toBe(404);
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  test('the router, allowlist and lane registries no longer name the retired routes', () => {
    const fs = require('fs');
    const path = require('path');
    const routerSrc = fs.readFileSync(path.join(__dirname, '../routes/review-gate.js'), 'utf8');
    expect(routerSrc).not.toMatch(/generate-review|generated_review_text|review_gate_text|dispatchWithFallback|'\/:token\/(score|submit)'|sendSMS|health-alerts/);
    const allow = fs.readFileSync(path.join(__dirname, '../config/public-route-allowlist.json'), 'utf8');
    expect(allow).not.toMatch(/api\/rate\/:token\/(generate-review|score|submit)/);
    const { LANES, LANE_AREA, LANE_DESCRIBE } = require('../services/model-switchboard');
    expect(LANES.length).toBeGreaterThan(10);
    expect(JSON.stringify([LANES, LANE_AREA, LANE_DESCRIBE])).not.toMatch(/review_gate_text/);
    expect(fs.readFileSync(path.join(__dirname, '../services/agent-control/lane-policies.js'), 'utf8')).not.toMatch(/review_gate_text/);
  });
});
