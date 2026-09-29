/**
 * Portal satisfaction card (owner ruling 2026-09-29: neutral review asks).
 * POST /api/satisfaction returns the SAME review link for every score, through
 * ONE path — the gated ask plus its queued / held / already_reviewed /
 * in-cadence / concurrent fallbacks. A score below 8 alerts the office FIRST
 * (unchanged) and still gets the link; only `action` differs.
 */
jest.mock('../models/db', () => {
  const state = { inserts: [] };
  const fn = jest.fn((table) => {
    const q = {};
    for (const m of ['where', 'leftJoin', 'select']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => {
      if (table === 'service_records') return { id: 'rec-1', service_type: 'Pest Control', service_date: '2026-09-28', technician_name: 'Alex' };
      return undefined; // satisfaction_responses: no duplicate
    });
    q.insert = jest.fn(async (row) => { state.inserts.push([table, row]); return [1]; });
    q.update = jest.fn(async () => 1);
    return q;
  });
  fn.state = state;
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({})) }));
jest.mock('../services/review-request', () => ({
  sendGatedAsk: jest.fn(),
  livePortalReviewUrlFor: jest.fn(),
  checkUnscheduledAskGates: jest.fn(),
}));
jest.mock('../services/account-properties', () => {
  const actual = jest.requireActual('../services/account-properties');
  return { ...actual, resolveSessionScope: jest.fn(async () => ({ enabled: false, scoped: false, closed: false, property: null })) };
});
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Lee', phone: '+19415550100', nearest_location_id: 'bradenton' };
    next();
  },
}));

const express = require('express');
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const ReviewService = require('../services/review-request');
const { resolveReviewLocation } = require('../config/locations');

const office = resolveReviewLocation({ nearest_location_id: 'bradenton' }, { storedLocationId: 'bradenton' });
const TOKEN_URL = 'https://portal.test/l/abc123';

let server; let base;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/satisfaction', require('../routes/satisfaction'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
  db.state.inserts = [];
  ReviewService.sendGatedAsk.mockResolvedValue({ outcome: 'sent', reviewUrl: TOKEN_URL });
  ReviewService.livePortalReviewUrlFor.mockResolvedValue(null);
  ReviewService.checkUnscheduledAskGates.mockResolvedValue(null);
});

const rate = async (rating, feedbackText) => {
  const res = await fetch(`${base}/satisfaction`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ serviceRecordId: 'rec-1', rating, feedbackText }),
  });
  return { status: res.status, body: await res.json() };
};

describe('every score gets the same review link', () => {
  test.each([
    [3, 'followup'],
    [6, 'followup'],
    [9, 'review'],
  ])('rating %i: link present, action %s, one gated ask', async (rating, action) => {
    const { status, body } = await rate(rating);
    expect(status).toBe(200);
    expect(body).toEqual({ success: true, action, reviewLink: TOKEN_URL, officeName: office.name });
    expect(ReviewService.sendGatedAsk).toHaveBeenCalledTimes(1);
    expect(ReviewService.sendGatedAsk).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', triggeredBy: 'portal_satisfaction' }));
  });

  test('the response row keeps its rating-based flags (badges read directed_to_review as the high-score marker)', async () => {
    await rate(3);
    await rate(9);
    const rows = db.state.inserts.filter(([t]) => t === 'satisfaction_responses').map(([, r]) => r);
    expect(rows.map((r) => [r.rating, r.directed_to_review, r.flagged_for_followup])).toEqual([[3, false, true], [9, true, false]]);
  });
});

describe('the office alert for a low score is unchanged and comes before the ask', () => {
  test('rating 3: URGENT alert with feedback, then the link', async () => {
    const order = [];
    TwilioService.sendSMS.mockImplementation(async () => { order.push('alert'); return {}; });
    ReviewService.sendGatedAsk.mockImplementation(async () => { order.push('ask'); return { outcome: 'sent', reviewUrl: TOKEN_URL }; });
    const { body } = await rate(3, 'Missed the lanai');
    expect(order).toEqual(['alert', 'ask']);
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    const [phone, text, opts] = TwilioService.sendSMS.mock.calls[0];
    expect(phone).toBeTruthy();
    expect(text).toMatch(/^🚨 URGENT Satisfaction Alert/);
    expect(text).toMatch(/Pat Lee rated their Pest Control \(2026-09-28\) a 3\/10/);
    expect(text).toMatch(/Feedback: "Missed the lanai"/);
    expect(text).toMatch(/Follow up ASAP — detractor score\./);
    expect(opts).toEqual({ messageType: 'internal_alert', link: '/admin/reviews' });
    expect(body.reviewLink).toBe(TOKEN_URL);
  });

  test('rating 6: the softer alert; rating 9: no alert at all', async () => {
    await rate(6);
    expect(TwilioService.sendSMS.mock.calls[0][1]).toMatch(/^⚠️ Satisfaction Alert[\s\S]*a 6\/10[\s\S]*Follow up within 24 hours\./);
    TwilioService.sendSMS.mockClear();
    await rate(9);
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });

  test('a failing alert never fails the rating or withholds the link', async () => {
    TwilioService.sendSMS.mockRejectedValueOnce(new Error('twilio down'));
    const { status, body } = await rate(3);
    expect(status).toBe(200);
    expect(body.reviewLink).toBe(TOKEN_URL);
  });
});

describe('the existing fallback and finality rules apply identically to every score', () => {
  const scenarios = [
    ['already_reviewed gets no link (finality)', { outcome: 'already_reviewed' }, null, null],
    ['a queued ask gets no link (the queued text carries it)', { outcome: 'deferred' }, null, null],
    ['a held ask gets no link', { outcome: 'blocked', code: 'REVIEW_COOLDOWN' }, null, null],
    ['in_cadence reuses the live delivered token, never the bare URL', { outcome: 'in_cadence' }, 'https://portal.test/l/live99', 'https://portal.test/l/live99'],
    ['in_cadence with no live token gets no link', { outcome: 'in_cadence' }, null, null],
    ['a thrown ask falls back to the bare office profile URL', 'throw', null, office.googleReviewUrl],
  ];
  test.each(scenarios)('%s', async (_name, asked, live, expected) => {
    const seen = [];
    for (const rating of [3, 6, 9]) {
      if (asked === 'throw') ReviewService.sendGatedAsk.mockRejectedValueOnce(new Error('boom'));
      else ReviewService.sendGatedAsk.mockResolvedValueOnce(asked);
      ReviewService.livePortalReviewUrlFor.mockResolvedValue(live);
      const { body } = await rate(rating);
      seen.push(body.reviewLink);
    }
    expect(seen).toEqual([expected, expected, expected]);
  });

  test('a concurrent in-flight ask settles on its tokenized link for every score', async () => {
    for (const rating of [3, 9]) {
      ReviewService.sendGatedAsk.mockResolvedValueOnce({ outcome: 'concurrent' });
      ReviewService.livePortalReviewUrlFor.mockReset();
      ReviewService.livePortalReviewUrlFor.mockResolvedValueOnce(null).mockResolvedValueOnce('https://portal.test/l/settled');
      const { body } = await rate(rating);
      expect(body.reviewLink).toBe('https://portal.test/l/settled');
    }
  });
});
