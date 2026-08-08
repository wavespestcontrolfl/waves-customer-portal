/**
 * Public-route hardening (security review 2026-08-07): token/code format
 * gates reject malformed input BEFORE any DB work with the same response an
 * unknown value gets (no format oracle), legacy token shapes stay valid
 * (prod-verified ranges), per-route limiters are attached, and new short
 * codes carry the 10-char entropy floor.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'gate-test-secret';

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../config/feature-gates', () => ({
  gates: { autoApplyAccountCredit: false },
  isEnabled: jest.fn(() => false),
}));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/invoice', () => ({ getByToken: jest.fn(async () => null) }));

// Chainable db mock — every query resolves empty; the assertions only care
// WHETHER the db was touched, never what it returns.
jest.mock('../models/db', () => {
  const chain = () => {
    const q = {};
    const ms = ['where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull',
      'andWhere', 'orWhere', 'orderBy', 'limit', 'select', 'first', 'update', 'insert',
      'increment', 'returning', 'catch'];
    for (const m of ms) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => null);
    q.then = (ok, err) => Promise.resolve([]).then(ok, err);
    return q;
  };
  const fn = jest.fn(() => chain());
  fn.raw = jest.fn((sql) => sql);
  fn.fn = { now: jest.fn(() => 'now()') };
  return fn;
});

const express = require('express');
const db = require('../models/db');
const InvoiceService = require('../services/invoice');

let server;
let base;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/pay', require('../routes/pay-v2'));
  app.use('/r', require('../routes/referral-links'));
  app.use('/api/rate', require('../routes/review-gate'));
  app.use('/l', require('../routes/public-shortlinks'));
  app.use((err, req, res, next) => {  
    res.status(err.status || 500).json({ error: err.message });
  });
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => { server.close(done); });

beforeEach(() => {
  db.mockClear();
  InvoiceService.getByToken.mockClear();
});

const get = (path, opts) => fetch(`${base}${path}`, { redirect: 'manual', ...opts });

describe('pay-v2 token format gate (url-safe 20-64; legacy 25-32 stay valid)', () => {
  test('too-short token → generic 404, no service/db lookup', async () => {
    const res = await get('/api/pay/short-token-19chars'.slice(0, 8 + 19));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Invoice not found');
    expect(InvoiceService.getByToken).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  test('bad-charset token → generic 404, no lookup', async () => {
    const res = await get(`/api/pay/${encodeURIComponent("' OR 1=1 --............")}`);
    expect(res.status).toBe(404);
    expect(InvoiceService.getByToken).not.toHaveBeenCalled();
  });

  test('legacy 25-char url-safe token passes the gate (lookup runs)', async () => {
    const res = await get(`/api/pay/${'a'.repeat(25)}`);
    expect(res.status).toBe(404); // unknown token — but it DID reach the lookup
    expect(InvoiceService.getByToken).toHaveBeenCalledTimes(1);
  });

  test('current 64-hex token passes the gate', async () => {
    await get(`/api/pay/${'ab'.repeat(32)}`);
    expect(InvoiceService.getByToken).toHaveBeenCalledTimes(1);
  });

  test('router carries a rate limiter (standard headers present)', async () => {
    const res = await get(`/api/pay/${'ab'.repeat(32)}`);
    expect(res.headers.get('ratelimit-limit')).toBeTruthy();
  });
});

describe('/r/:code referral gate (url-safe 4-32)', () => {
  test('malformed code → redirect home, db never touched', async () => {
    const res = await get(`/r/${encodeURIComponent('bad code!!')}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://wavespestcontrol.com');
    expect(db).not.toHaveBeenCalled();
  });

  test('valid-format unknown code → same redirect, after a real lookup', async () => {
    const res = await get('/r/WAVES-abc123');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://wavespestcontrol.com');
    expect(db).toHaveBeenCalled();
  });

  test('route carries a rate limiter', async () => {
    const res = await get('/r/WAVES-abc123');
    expect(res.headers.get('ratelimit-limit')).toBeTruthy();
  });
});

describe('review-gate token gate (url-safe 32-64)', () => {
  test('malformed token → generic 404, db never touched', async () => {
    const res = await get('/api/rate/tooshort');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Review link not found or expired');
    expect(db).not.toHaveBeenCalled();
  });

  test('malformed token on /go degrades to the rate page, never a bare 404', async () => {
    const res = await get('/api/rate/tooshort/go');
    expect(res.status).toBe(302);
    // ABSOLUTE portal origin — a root-relative /rate resolves on the API
    // origin (404) in a split-origin deploy (codex #3285 r5).
    const { publicPortalUrl } = require('../utils/portal-url');
    expect(res.headers.get('location')).toBe(`${publicPortalUrl()}/rate/tooshort`);
    expect(db).not.toHaveBeenCalled();
  });

  test('legacy 32-char url-safe token passes the gate (lookup runs)', async () => {
    const res = await get(`/api/rate/${'Zz-_'.repeat(8)}`);
    expect(res.status).toBe(404); // unknown — but the review_requests lookup ran
    expect(db).toHaveBeenCalledWith('review_requests');
  });

  test('page GET carries a rate limiter', async () => {
    const res = await get(`/api/rate/${'a'.repeat(64)}`);
    expect(res.headers.get('ratelimit-limit')).toBeTruthy();
  });
});

describe('review-gate /go expired-link handling (review audit 2026-08-07)', () => {
  const { isEnabled } = require('../config/feature-gates');
  // Fallbacks are ABSOLUTE portal-origin (split-origin safe — codex #3285 r5).
  const { publicPortalUrl } = require('../utils/portal-url');
  const { WAVES_LOCATIONS } = require('../config/locations');

  afterEach(() => {
    isEnabled.mockImplementation(() => false);
  });

  test('legacy 32-char url-safe token reaches the /go lookup (codex #3287 r1)', async () => {
    isEnabled.mockImplementation((key) => key === 'reviewDirectLink');
    // Unknown token → rate-page fallback, but the review_requests lookup
    // RAN — a 64-hex-only shape check used to bounce legacy tokens here.
    const res = await get(`/api/rate/${'Zz-_'.repeat(8)}/go`);
    expect(res.status).toBe(302);
    expect(db).toHaveBeenCalledWith('review_requests');
  });

  test('expired request 302s to the location GBP with NO stamping', async () => {
    isEnabled.mockImplementation((key) => key === 'reviewDirectLink');
    const loc = WAVES_LOCATIONS[0];
    const updateSpy = jest.fn();
    db.mockImplementation((table) => {
      const q = {};
      for (const m of ['where', 'whereNull', 'orderBy', 'limit', 'select']) q[m] = jest.fn(() => q);
      q.update = updateSpy;
      q.first = jest.fn(async () => {
        if (table === 'review_requests') {
          return {
            id: 'rr-expired',
            customer_id: 'cust-1',
            location_id: loc.id,
            expires_at: '2020-01-01T00:00:00.000Z',
          };
        }
        return null; // customers: no geocode → location_id fallback resolves
      });
      return q;
    });

    const res = await get(`/api/rate/${'ab'.repeat(32)}/go`);
    expect(res.status).toBe(302);
    // A willing reviewer on an old text still reaches the review form...
    expect(res.headers.get('location')).toBe(loc.googleReviewUrl);
    // ...but an out-of-window token records nothing: no click stamp, no
    // cadence stop, no owner bell.
    expect(updateSpy).not.toHaveBeenCalled();
  });

  const installGoDb = ({ request, customer = null }) => {
    const updateSpy = jest.fn();
    db.mockImplementation((table) => {
      const q = {};
      for (const m of ['where', 'whereNull', 'orderBy', 'limit', 'select']) q[m] = jest.fn(() => q);
      q.update = updateSpy;
      q.first = jest.fn(async () => (table === 'review_requests' ? request : customer));
      return q;
    });
    return updateSpy;
  };

  test('finalized requests never redirect to Google — expired or live (audit P1)', async () => {
    isEnabled.mockImplementation((key) => key === 'reviewDirectLink');
    const token = 'ab'.repeat(32);
    // Expired AND already rated → rate-page fallback, not a revived ask.
    let updateSpy = installGoDb({
      request: { id: 'rr-1', customer_id: 'c1', rated_at: '2026-05-01T00:00:00Z', expires_at: '2020-01-01T00:00:00.000Z' },
    });
    let res = await get(`/api/rate/${token}/go`);
    expect(res.headers.get('location')).toBe(`${publicPortalUrl()}/rate/${token}`);
    expect(updateSpy).not.toHaveBeenCalled();
    // Live but submitted (a detractor's feedback) → rate page's
    // alreadySubmitted state, never Google.
    updateSpy = installGoDb({
      request: { id: 'rr-2', customer_id: 'c1', status: 'submitted' },
    });
    res = await get(`/api/rate/${token}/go`);
    expect(res.headers.get('location')).toBe(`${publicPortalUrl()}/rate/${token}`);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  test('customers marked has_left_google_review are not re-solicited via /go', async () => {
    isEnabled.mockImplementation((key) => key === 'reviewDirectLink');
    const token = 'ab'.repeat(32);
    const { WAVES_LOCATIONS: locs } = require('../config/locations');
    const updateSpy = installGoDb({
      request: { id: 'rr-3', customer_id: 'c1', location_id: locs[0].id },
      customer: { id: 'c1', has_left_google_review: true },
    });
    const res = await get(`/api/rate/${token}/go`);
    expect(res.headers.get('location')).toBe(`${publicPortalUrl()}/rate/${token}`);
    expect(updateSpy).not.toHaveBeenCalled();
  });
});

describe('/l shortlink limiter + code entropy', () => {
  test('resolver carries a rate limiter', async () => {
    const res = await get('/l/abc12');
    expect(res.headers.get('ratelimit-limit')).toBeTruthy();
  });

  test('new short codes are 10 chars (≈49.5 bits) — legacy resolve by DB value, not shape', async () => {
    const inserted = [];
    db.mockImplementation(() => {
      const q = {};
      ['where', 'first'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.insert = jest.fn((row) => { inserted.push(row); return q; });
      q.returning = jest.fn(async () => [{ code: inserted[inserted.length - 1].code }]);
      return q;
    });
    const { createShortCode } = require('../services/short-url');
    await createShortCode('https://portal.wavespestcontrol.com/x', { kind: 'test' });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].code).toMatch(/^[a-z0-9]{10}$/);
  });
});
