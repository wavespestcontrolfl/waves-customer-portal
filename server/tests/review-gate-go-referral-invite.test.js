/**
 * /api/rate/:token/go — the referral invite email (owner ruling 2026-09-29:
 * "send the referral invite right after a customer taps the Google review
 * button"). Sent once, on the FIRST tracked click only (the request that wins
 * the atomic redirected_at claim), never delaying or breaking the 302.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'go-referral-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gates: {}, isEnabled: jest.fn() }));
jest.mock('../services/review-request', () => ({
  REVIEW_TOKEN_RE: /^[A-Za-z0-9_-]{32,64}$/,
  stopFutureAsks: jest.fn(async () => {}),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => {}) }));
jest.mock('../services/referral-invite-email', () => ({ sendReferralInviteEmail: jest.fn(async () => null) }));
jest.mock('../models/db', () => {
  const state = { request: null, customer: null, activeSeq: null };
  const fn = jest.fn((table) => {
    const q = { _nullCols: [] };
    for (const m of ['where', 'orderBy', 'limit', 'select']) q[m] = jest.fn(() => q);
    q.whereNull = jest.fn((c) => { q._nullCols.push(c); return q; });
    q.first = jest.fn(async () => {
      if (table === 'review_requests') return state.request;
      if (table === 'customers') return state.customer;
      if (table === 'review_sequences') return state.activeSeq;
      return null;
    });
    q.update = jest.fn(async (patch) => {
      if (table !== 'review_requests') return 1;
      // Atomic first-click claim: WHERE redirected_at IS NULL.
      if (q._nullCols.includes('redirected_at') && state.request.redirected_at) return 0;
      Object.assign(state.request, patch);
      return 1;
    });
    return q;
  });
  fn.state = state;
  fn.raw = jest.fn((s) => s);
  return fn;
});

const express = require('express');
const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { stopFutureAsks } = require('../services/review-request');
const { sendReferralInviteEmail } = require('../services/referral-invite-email');
const { WAVES_LOCATIONS } = require('../config/locations');
const { publicPortalUrl } = require('../utils/portal-url');

const loc = WAVES_LOCATIONS[0];
const TOKEN = 'ab'.repeat(32);
const UA = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1' };
let server; let base;

beforeAll((done) => {
  const app = express();
  app.use('/api/rate', require('../routes/review-gate'));
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
    db.state.customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Lee', has_left_google_review: false };
  db.state.request = {
    id: 'rr-1', token: TOKEN, customer_id: 'cust-1', location_id: loc.id, status: 'sent',
    sequence_id: null, expires_at: null, opened_at: null, redirected_at: null,
  };
});

const go = (headers = UA) => fetch(`${base}/api/rate/${TOKEN}/go`, { redirect: 'manual', headers });
const flush = () => new Promise((r) => setImmediate(r));

describe.each([true, false])('GATE_REVIEW_DIRECT_LINK=%s (review sequences ON) — /go tracks either way', (gateOn) => {
  beforeEach(() => {
    isEnabled.mockImplementation((k) => (k === 'reviewDirectLink' ? gateOn : k === 'reviewSequences'));
  });

  test('the first click stamps, stops the cadence, sends the invite once with trigger google_review_click, then 302s to Google', async () => {
    const res = await go();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(loc.googleReviewUrl);
    await flush();
    expect(sendReferralInviteEmail).toHaveBeenCalledTimes(1);
    expect(sendReferralInviteEmail).toHaveBeenCalledWith({ customerId: 'cust-1', trigger: 'google_review_click' });
    // Tracked: the click is stamped (first-click claim + open) and the cadence stops.
    expect(db.state.request).toMatchObject({ google_review_clicked: true, redirected_to_google: true, google_location: loc.id });
    expect(db.state.request.redirected_at).toBeInstanceOf(Date);
    expect(stopFutureAsks).toHaveBeenCalledWith('cust-1', { sequenceId: null, reason: 'clicked' });
  });

  test('a second click on the same request does not call the invite again (first-click claim already taken)', async () => {
    await go();
    const second = await go();
    expect(second.status).toBe(302);
    expect(second.headers.get('location')).toBe(loc.googleReviewUrl);
    await flush();
    expect(sendReferralInviteEmail).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['a finalized (legacy-rated) request', () => { db.state.request.rated_at = new Date(); }],
    ['status submitted', () => { db.state.request.status = 'submitted'; }],
    ['an already-reviewed customer', () => { db.state.customer.has_left_google_review = true; }],
    ['an expired link', () => { db.state.request.expires_at = '2020-01-01T00:00:00.000Z'; }],
  ])('%s: no invite', async (_n, arrange) => {
    arrange();
    const res = await go();
    expect(res.status).toBe(302);
    await flush();
    expect(sendReferralInviteEmail).not.toHaveBeenCalled();
    expect(stopFutureAsks).not.toHaveBeenCalled();
    if (_n !== 'an expired link') expect(res.headers.get('location')).toBe(`${publicPortalUrl()}/rate/${TOKEN}`);
  });

  test('if stopping the later asks fails, the customer stays on the rate page: no Google redirect, no invite', async () => {
    stopFutureAsks.mockRejectedValueOnce(new Error('db down'));
    const res = await go();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${publicPortalUrl()}/rate/${TOKEN}`);
    await flush();
    expect(sendReferralInviteEmail).not.toHaveBeenCalled();
  });

  test('a link-scanner / bot fetch records nothing and sends no invite', async () => {
    const res = await go({ 'user-agent': 'facebookexternalhit/1.1' });
    expect(res.status).toBe(302);
    await flush();
    expect(sendReferralInviteEmail).not.toHaveBeenCalled();
  });

  test('a thrown or rejected invite never breaks or delays the 302', async () => {
    sendReferralInviteEmail.mockImplementationOnce(() => { throw new Error('boom'); });
    let res = await go();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(loc.googleReviewUrl);

    db.state.request.redirected_at = null;
    sendReferralInviteEmail.mockImplementationOnce(() => new Promise(() => {})); // never settles
    res = await go();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(loc.googleReviewUrl);
  });
});
