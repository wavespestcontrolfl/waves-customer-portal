/**
 * POST /api/review/:token was an unauthenticated rating write (redirected_at,
 * status 'reviewed', a referral invite) with no Google tap. Retired
 * (owner ruling 2026-09-29): 410 Gone with no DB access; GET is unchanged.
 */
jest.mock('../models/db', () => jest.fn(() => { throw new Error('db must not be touched'); }));
const mockSubmitRating = jest.fn();
jest.mock('../services/review-request', () => ({
  REVIEW_TOKEN_RE: /^[A-Za-z0-9_-]{32,64}$/,
  getByToken: jest.fn(async () => ({ firstName: 'Pat' })),
  submitRating: (...a) => mockSubmitRating(...a),
}));
const express = require('express');
const db = require('../models/db');

const TOKEN = 'ef'.repeat(32);
let server; let base;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/review', require('../routes/review-public'));
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

test('POST answers 410 with no DB access and never reaches submitRating', async () => {
  const res = await fetch(`${base}/api/review/${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rating: 10 }) });
  expect(res.status).toBe(410);
  expect(res.headers.get('cache-control')).toMatch(/no-store/);
  expect(db).not.toHaveBeenCalled();
  expect(mockSubmitRating).not.toHaveBeenCalled();
});

test('a malformed token still gets the generic 404 first; GET still works', async () => {
  expect((await fetch(`${base}/api/review/short`, { method: 'POST' })).status).toBe(404);
  expect((await fetch(`${base}/api/review/${TOKEN}`)).status).toBe(200);
});
