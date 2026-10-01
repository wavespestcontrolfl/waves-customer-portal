/**
 * /go over-limit fallback: the rate page's only control is /go, so the
 * limiter's redirect back to it carries ?retry=1 (the page then says "try again
 * in a minute" instead of looping silently).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'go-limit-secret';
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gates: {}, isEnabled: jest.fn(() => true) }));
jest.mock('../services/review-request', () => ({ REVIEW_TOKEN_RE: /^[A-Za-z0-9_-]{32,64}$/ }));
jest.mock('../models/db', () => {
  const fn = jest.fn(() => { const q = {}; for (const m of ['where', 'select']) q[m] = jest.fn(() => q); q.first = jest.fn(async () => null); return q; });
  return fn;
});
const express = require('express');
const { publicPortalUrl } = require('../utils/portal-url');

const TOKEN = 'cd'.repeat(32);
let server; let base;
beforeAll((done) => {
  const app = express();
  app.use('/api/rate', require('../routes/review-gate'));
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

test('past 30 hits a minute the /go limiter redirects to /rate/<token>?retry=1; earlier failures with an unknown token do not', async () => {
  const hit = () => fetch(`${base}/api/rate/${TOKEN}/go`, { redirect: 'manual' });
  const first = await hit();
  expect(first.headers.get('location')).toBe(`${publicPortalUrl()}/rate/${TOKEN}`); // unknown request: nothing to retry
  let last;
  for (let i = 0; i < 31; i += 1) last = await hit();
  expect(last.status).toBe(302);
  expect(last.headers.get('location')).toBe(`${publicPortalUrl()}/rate/${TOKEN}?retry=1`);
});
