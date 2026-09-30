/**
 * Portal Google review card (owner ruling 2026-09-29: the 1-10 rating is
 * retired; one tap to Google). GET /api/satisfaction/review-card offers the
 * card under the old prompt's eligibility, links ONLY to the customer's live
 * tracked /go token (never a bare office URL: an untracked tap would let an ask
 * enrolled a moment later still text them), and sends NOTHING. The
 * rating POST and the pending-prompt GET no longer exist.
 */
jest.mock('../models/db', () => {
  const state = { visits: [], scheduled: [], clicked: null };
  const fn = jest.fn((table) => {
    const q = {};
    for (const m of ['where', 'whereNotNull', 'whereNull', 'leftJoin', 'select', 'orderBy', 'limit']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => {
      if (table === 'review_requests') return state.clicked;
      // visitAnchor (review-click-guard) reads the visit's service_date.
      if (table === 'service_records') return state.visits[0] ? { service_date: state.visits[0].service_date } : undefined;
      if (table === 'scheduled_services') return state.scheduled[0] ? { scheduled_date: state.scheduled[0].scheduled_date } : undefined;
      return undefined;
    });
    q.then = (ok, err) => Promise.resolve(table === 'service_records' ? state.visits : table === 'scheduled_services' ? state.scheduled : []).then(ok, err);
    return q;
  });
  fn.state = state;
  return fn;
});
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({})) }));
jest.mock('../services/review-request', () => ({
  sendGatedAsk: jest.fn(),
  reviewSmsAllowedNow: jest.fn(),
  _liveReviewToken: jest.fn(),
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
const { publicPortalUrl } = require('../utils/portal-url');
const TOKEN_URL = `${publicPortalUrl()}/api/rate/${'t'.repeat(40)}/go`;
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
  db.state.scheduled = [];
  db.state.clicked = null;
  ReviewService.reviewSmsAllowedNow.mockResolvedValue({ allowed: true });
  ReviewService._liveReviewToken.mockResolvedValue('t'.repeat(40));
});

const card = async () => (await fetch(`${base}/satisfaction/review-card`)).json();
const expectNothingSent = () => {
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  expect(ReviewService.sendGatedAsk).not.toHaveBeenCalled();
};

describe('GET /review-card — tracked links only, never a send', () => {
  test('a live tracked token: the card carries its /go link', async () => {
    expect(await card()).toEqual({
      card: { serviceRecordId: 'rec-1', scheduledServiceId: null, serviceType: 'Pest Control', technicianName: 'Alex', reviewLink: TOKEN_URL, officeName: office.name },
      propertyScope: expect.anything(),
    });
    expectNothingSent();
  });

  test('no live token: NO card — the bare office URL is never offered', async () => {
    ReviewService._liveReviewToken.mockResolvedValue(null);
    const body = await card();
    expect(body.card).toBeNull();
    expect(JSON.stringify(body)).not.toContain(office.googleReviewUrl);
    expectNothingSent();
  });

  test.each(['review_off', 'customer_deleted', 'already_reviewed', 'prefs_unavailable'])('review opt-out / ineligible (%s): no card, no token read', async (reason) => {
    ReviewService.reviewSmsAllowedNow.mockResolvedValue({ allowed: false, reason });
    expect((await card()).card).toBeNull();
    expect(ReviewService._liveReviewToken).not.toHaveBeenCalled();
  });

  test.each(['sms_off', 'email_only'])('%s does not hide the card (it is a button, not a text)', async (reason) => {
    ReviewService.reviewSmsAllowedNow.mockResolvedValue({ allowed: false, reason });
    expect((await card()).card.reviewLink).toBe(TOKEN_URL);
  });

  test('already_reviewed (has_left_google_review): no card and no lookups at all', async () => {
    global.__LEFT__ = true;
    expect(await card()).toEqual({ card: null });
    expect(db).not.toHaveBeenCalled();
    expect(ReviewService._liveReviewToken).not.toHaveBeenCalled();
    expectNothingSent();
  });

  test('a completed visit with NO service record (scheduled_services only): the card is shown, keyed on the scheduled visit id', async () => {
    db.state.visits = [];
    db.state.scheduled = [{ scheduled_service_id: 'ss-9', service_type: 'Lawn Care', technician_name: null, scheduled_date: '2026-09-28' }];
    expect(await card()).toEqual({
      card: { serviceRecordId: null, scheduledServiceId: 'ss-9', serviceType: 'Lawn Care', technicianName: null, reviewLink: TOKEN_URL, officeName: office.name },
      propertyScope: expect.anything(),
    });
    // ...and a tracked click since that visit ends it (same anchor as the guard).
    db.state.clicked = { id: 'rr-9' };
    expect((await card()).card).toBeNull();
  });

  test('an older service record does not mask a NEWER record-less visit: both sources are compared and the newest wins', async () => {
    db.state.visits = [{ id: 'rec-mon', service_type: 'Pest Control', service_date: '2026-09-22', technician_name: 'Alex' }];
    db.state.scheduled = [{ scheduled_service_id: 'ss-thu', service_type: 'Lawn Care', technician_name: null, scheduled_date: '2026-09-25' }];
    const res = await card();
    expect(res.card).toMatchObject({ serviceRecordId: null, scheduledServiceId: 'ss-thu', serviceType: 'Lawn Care' });
  });

  test('same-day visits from both sources: the later completion instant wins', async () => {
    db.state.visits = [{ id: 'rec-am', service_type: 'Pest Control', service_date: '2026-09-25', ended_at: '2026-09-25T14:00:00Z', technician_name: 'Alex' }];
    db.state.scheduled = [{ scheduled_service_id: 'ss-pm', service_type: 'Lawn Care', technician_name: null, scheduled_date: '2026-09-25', check_out_time: '2026-09-25T20:00:00Z' }];
    expect((await card()).card).toMatchObject({ scheduledServiceId: 'ss-pm' });
    db.state.visits = [{ id: 'rec-pm', service_type: 'Pest Control', service_date: '2026-09-25', ended_at: '2026-09-25T21:00:00Z', technician_name: 'Alex' }];
    expect((await card()).card).toMatchObject({ serviceRecordId: 'rec-pm' });
  });

  test('no completed visit in the window: no card', async () => {
    db.state.visits = [];
    expect((await card()).card).toBeNull();
  });

  test('a tracked click since the visit ends the card', async () => {
    db.state.clicked = { id: 'rr-9' };
    expect((await card()).card).toBeNull();
  });

  test('the consent / token read fails closed: an error is a 500, never a card', async () => {
    ReviewService._liveReviewToken.mockRejectedValue(new Error('db down'));
    const res = await fetch(`${base}/satisfaction/review-card`);
    expect(res.status).toBe(500);
  });

  test('futureAskState is gone from the codebase (the card was its only caller)', () => {
    const fs = require('fs');
    const path = require('path');
    for (const f of ['../services/review-request.js', '../services/portal-review-card.js', '../routes/satisfaction.js']) {
      expect(fs.readFileSync(path.join(__dirname, f), 'utf8')).not.toMatch(/futureAskState|summary_may_enroll|pendingAskState/);
    }
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
