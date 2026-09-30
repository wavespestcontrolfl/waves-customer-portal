/**
 * Portal Google review card (owner ruling 2026-09-29: the 1-10 rating is
 * retired; one tap to Google). GET /api/satisfaction/review-card offers the
 * card under the old prompt's eligibility, links to the customer's live
 * tracked token or the office's Google review URL, and sends NOTHING. The
 * rating POST and the pending-prompt GET no longer exist.
 */
jest.mock('../models/db', () => {
  const state = { visits: [], clicked: null };
  const fn = jest.fn((table) => {
    const q = {};
    for (const m of ['where', 'whereNotNull', 'leftJoin', 'select', 'orderBy', 'limit']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => (table === 'review_requests' ? state.clicked : undefined));
    q.then = (ok, err) => Promise.resolve(table === 'service_records' ? state.visits : []).then(ok, err);
    return q;
  });
  fn.state = state;
  return fn;
});
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({})) }));
jest.mock('../services/review-request', () => ({
  sendGatedAsk: jest.fn(),
  livePortalReviewUrlFor: jest.fn(),
  pendingAskState: jest.fn(),
}));
jest.mock('../services/account-properties', () => {
  const actual = jest.requireActual('../services/account-properties');
  return { ...actual, resolveSessionScope: jest.fn(async () => ({ enabled: false, scoped: false, closed: false, property: null })) };
});
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Lee', nearest_location_id: 'bradenton', has_left_google_review: global.__LEFT__ === true };
    next();
  },
}));

const express = require('express');
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const ReviewService = require('../services/review-request');
const { resolveReviewLocation } = require('../config/locations');

const office = resolveReviewLocation({ nearest_location_id: 'bradenton' }, { storedLocationId: 'bradenton' });
const TOKEN_URL = 'https://portal.test/api/rate/tok/go';
const VISIT = { id: 'rec-1', service_type: 'Pest Control', service_date: '2026-09-28', technician_name: 'Alex' };

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
  global.__LEFT__ = false;
  db.state.visits = [VISIT];
  db.state.clicked = null;
  ReviewService.pendingAskState.mockResolvedValue({ oneOff: null, cadence: false });
  ReviewService.livePortalReviewUrlFor.mockResolvedValue(null);
});

const card = async () => (await fetch(`${base}/satisfaction/review-card`)).json();
const expectNothingSent = () => {
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  expect(ReviewService.sendGatedAsk).not.toHaveBeenCalled();
};

describe('GET /review-card — a link, never a send', () => {
  test('customer WITH a live tracked token: the card carries that token link', async () => {
    ReviewService.livePortalReviewUrlFor.mockResolvedValue(TOKEN_URL);
    expect(await card()).toEqual({
      card: { serviceRecordId: 'rec-1', serviceType: 'Pest Control', technicianName: 'Alex', reviewLink: TOKEN_URL, officeName: office.name },
      propertyScope: expect.anything(),
    });
    expectNothingSent();
  });

  test('customer WITHOUT a live token: the card carries the office Google review URL', async () => {
    const body = await card();
    expect(body.card.reviewLink).toBe(office.googleReviewUrl);
    expect(body.card.officeName).toBe(office.name);
    expectNothingSent();
  });

  test('already_reviewed (has_left_google_review): no card and no lookups at all', async () => {
    global.__LEFT__ = true;
    expect(await card()).toEqual({ card: null });
    expect(db).not.toHaveBeenCalled();
    expect(ReviewService.livePortalReviewUrlFor).not.toHaveBeenCalled();
    expectNothingSent();
  });

  test('no completed visit in the window: no card', async () => {
    db.state.visits = [];
    expect((await card()).card).toBeNull();
  });

  test('a tracked click since the visit ends the card', async () => {
    db.state.clicked = { id: 'rr-9' };
    expect((await card()).card).toBeNull();
  });

  test.each(['already_queued', 'in_flight'])('a one-off ask %s: no card, even with a live token (its own text would still go out)', async (outcome) => {
    ReviewService.pendingAskState.mockResolvedValue({ oneOff: { outcome }, cadence: false });
    ReviewService.livePortalReviewUrlFor.mockResolvedValue(TOKEN_URL);
    expect((await card()).card).toBeNull();
    expectNothingSent();
  });

  test('in a cadence: the live token only — never the bare URL', async () => {
    ReviewService.pendingAskState.mockResolvedValue({ oneOff: null, cadence: true });
    expect((await card()).card).toBeNull();
    ReviewService.livePortalReviewUrlFor.mockResolvedValue(TOKEN_URL);
    expect((await card()).card.reviewLink).toBe(TOKEN_URL);
  });

  test('the pending-state read fails closed: an error is a 500, never a card', async () => {
    ReviewService.pendingAskState.mockRejectedValue(new Error('db down'));
    const res = await fetch(`${base}/satisfaction/review-card`);
    expect(res.status).toBe(500);
  });
});

describe('the rating endpoints are gone', () => {
  test('POST / (rating) and GET /pending → 404, no alert, no ask', async () => {
    const post = await fetch(`${base}/satisfaction`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serviceRecordId: 'rec-1', rating: 3, feedbackText: 'x' }),
    });
    expect(post.status).toBe(404);
    expect((await fetch(`${base}/satisfaction/pending`)).status).toBe(404);
    expectNothingSent();
    expect(db).not.toHaveBeenCalled();
  });
});
