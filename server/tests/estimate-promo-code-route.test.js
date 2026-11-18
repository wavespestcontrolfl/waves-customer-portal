/**
 * POST /api/estimates/:token/promo-code (GATE_ESTIMATE_PROMO_CODE): the
 * public-route guards. A dark gate, a staff preview and an estimate that
 * cannot be accepted all answer the same 404 an unknown token gets, before
 * the code is looked at; an open estimate hands the typed code to the service
 * and relays its answer. What a code is worth is covered against real
 * Postgres in estimate-promo-code-postgres.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'promo-route-test-secret';

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../config/feature-gates', () => ({ gates: {}, isEnabled: jest.fn(() => false) }));
const mockPromo = { enterPromoCode: jest.fn(), promoCodeViewForEstimate: jest.fn(), redeemPromoCodeForAcceptedEstimate: jest.fn() };
jest.mock('../services/estimate-promo-code', () => mockPromo);
const mockRow = { current: null };
jest.mock('../models/db', () => {
  const fn = jest.fn(() => {
    const q = {};
    for (const m of ['where', 'whereIn', 'whereNull', 'whereNot', 'select', 'orderBy', 'limit', 'forUpdate']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => mockRow.current);
    q.then = (ok, err) => Promise.resolve([]).then(ok, err);
    return q;
  });
  fn.raw = jest.fn((sql) => sql);
  // The entry transaction re-reads the estimate under its row lock on the same mock.
  fn.transaction = jest.fn((work) => work(fn));
  fn.fn = { now: jest.fn(() => 'now()') };
  return fn;
});

const express = require('express');
const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');

const TOKEN = 'a'.repeat(64);
const openEstimate = () => ({
  id: 'est-1', token: TOKEN, status: 'viewed', customer_id: 'cust-1', estimate_data: {},
  expires_at: new Date(Date.now() + 7 * 86400000),
});

let server;
let base;
let lastHeaders;
const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async (res) => { lastHeaders = res.headers; return { status: res.status, body: await res.json() }; });

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/estimates', require('../routes/estimate-public'));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  server.closeAllConnections();
  server.close(() => done());
});

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation((key) => key === 'estimatePromoCode');
  mockRow.current = openEstimate();
});

const NOT_FOUND = { status: 404, body: { error: 'Estimate not found' } };

test('dark gate, staff preview and a malformed token answer the generic 404 without a database read', async () => {
  expect(await post(`/api/estimates/${TOKEN}/promo-code?adminPreview=1`, { code: 'SAVE25' })).toEqual(NOT_FOUND);
  expect(await post('/api/estimates/not%20a%20token/promo-code', { code: 'SAVE25' })).toEqual(NOT_FOUND);
  isEnabled.mockReturnValue(false);
  expect(await post(`/api/estimates/${TOKEN}/promo-code`, { code: 'SAVE25' })).toEqual(NOT_FOUND);
  expect(db).not.toHaveBeenCalled();
  expect(mockPromo.enterPromoCode).not.toHaveBeenCalled();
});

test('an unknown, accepted or price-locked estimate answers the same 404 and never reaches the code', async () => {
  for (const row of [null, { ...openEstimate(), status: 'accepted' }, { ...openEstimate(), price_locked_at: new Date() }]) {
    mockRow.current = row;
    expect(await post(`/api/estimates/${TOKEN}/promo-code`, { code: 'SAVE25' })).toEqual(NOT_FOUND);
  }
  expect(mockPromo.enterPromoCode).not.toHaveBeenCalled();
});

test('an open estimate relays the service answer: 400 with the reason, or the applied code', async () => {
  expect(await post(`/api/estimates/${TOKEN}/promo-code`, { code: 12345 }))
    .toEqual({ status: 400, body: { error: 'invalid_code' } });
  expect(mockPromo.enterPromoCode).not.toHaveBeenCalled();

  mockPromo.enterPromoCode.mockResolvedValueOnce({ ok: false, reason: 'discount_already_applied' });
  expect(await post(`/api/estimates/${TOKEN}/promo-code`, { code: 'SAVE25' }))
    .toEqual({ status: 400, body: { error: 'discount_already_applied' } });

  const applied = { code: 'SAVE25', creditAmount: 25, credited: false };
  mockPromo.enterPromoCode.mockResolvedValueOnce({ ok: true, applied });
  expect(await post(`/api/estimates/${TOKEN}/promo-code`, { code: 'save25' }))
    .toEqual({ status: 200, body: { success: true, promoCode: { canEnter: false, applied } } });
  // The code is saved on the caller's transaction, the one holding the estimate row lock.
  expect(mockPromo.enterPromoCode).toHaveBeenLastCalledWith({ estimate: expect.objectContaining({ id: 'est-1' }), rawCode: 'save25' }, db);
  expect(lastHeaders.get('cache-control')).toBe('no-store');
  expect(lastHeaders.get('x-robots-tag')).toBe('noindex');
});

test('an estimate accepted while the request ran is refused on the locked row and the code is not saved', async () => {
  const rows = [openEstimate(), { ...openEstimate(), status: 'accepted' }];
  db.mockImplementation(() => {
    const q = {};
    for (const m of ['where', 'forUpdate']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => rows.shift() || null);
    return q;
  });
  expect(await post(`/api/estimates/${TOKEN}/promo-code`, { code: 'SAVE25' })).toEqual(NOT_FOUND);
  expect(mockPromo.enterPromoCode).not.toHaveBeenCalled();
});
