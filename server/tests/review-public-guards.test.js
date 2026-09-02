/**
 * /api/review/:token baseline public-token-route guards
 * (docs/public-route-contracts.md): token format gate before any DB read,
 * one generic 404 for malformed and unknown tokens on both verbs, privacy
 * headers on every response, router-wide rate limit.
 *
 * Real listen + fetch round-trips (repo has no supertest at the root).
 */
const express = require('express');

const mockGetByToken = jest.fn();
const mockSubmitRating = jest.fn();
jest.mock('../services/review-request', () => ({
  REVIEW_TOKEN_RE: /^[A-Za-z0-9_-]{32,64}$/,
  getByToken: (...a) => mockGetByToken(...a),
  submitRating: (...a) => mockSubmitRating(...a),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const reviewPublicRouter = require('../routes/review-public');

const VALID = 'ab'.repeat(32);
let server;
let base;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/review', reviewPublicRouter);
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });
beforeEach(() => { mockGetByToken.mockReset(); mockSubmitRating.mockReset(); });

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json, headers: res.headers };
}

describe('token format gate', () => {
  test.each([
    ['too short', 'abc'],
    ['bad charset', `${'a'.repeat(30)}$$`],
    ['too long', 'a'.repeat(65)],
  ])('malformed token (%s) is a generic 404 before any service call — GET', async (_label, token) => {
    const res = await call('GET', `/api/review/${token}`);
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'Review link not found or expired' });
    expect(mockGetByToken).not.toHaveBeenCalled();
  });

  test('malformed token is the same generic 404 on POST, before submitRating', async () => {
    const res = await call('POST', '/api/review/abc', { rating: 9 });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'Review link not found or expired' });
    expect(mockSubmitRating).not.toHaveBeenCalled();
  });

  test('unknown token on POST returns the SAME body as a malformed one', async () => {
    mockSubmitRating.mockRejectedValueOnce(new Error('Review request not found'));
    const res = await call('POST', `/api/review/${VALID}`, { rating: 9 });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'Review link not found or expired' });
  });

  test('expired token on POST is also the generic 404, not a 410', async () => {
    mockSubmitRating.mockRejectedValueOnce(new Error('Review link expired'));
    const res = await call('POST', `/api/review/${VALID}`, { rating: 9 });
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'Review link not found or expired' });
  });

  test('well-formed token reaches the service and the payload passes through', async () => {
    mockGetByToken.mockResolvedValueOnce({ customerFirstName: 'Megan', status: 'pending' });
    const res = await call('GET', `/api/review/${VALID}`);
    expect(res.status).toBe(200);
    expect(mockGetByToken).toHaveBeenCalledWith(VALID);
    expect(res.json).toEqual({ customerFirstName: 'Megan', status: 'pending' });
  });
});

describe('privacy headers', () => {
  test('every response carries no-store / noindex / no-referrer, including the malformed 404', async () => {
    for (const path of [`/api/review/${VALID}`, '/api/review/abc']) {
      mockGetByToken.mockResolvedValueOnce(null);
      const res = await call('GET', path);
      expect(res.headers.get('cache-control')).toMatch(/no-store/);
      expect(res.headers.get('x-robots-tag')).toMatch(/noindex/);
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });
});

describe('rate limit', () => {
  test('the router-wide limiter answers 429 past 30 requests per minute', async () => {
    mockGetByToken.mockResolvedValue(null);
    // The earlier tests consumed a handful of the window already; walk to the cap.
    let last;
    for (let i = 0; i < 40; i += 1) {
      last = await call('GET', `/api/review/${VALID}`);
      if (last.status === 429) break;
    }
    expect(last.status).toBe(429);
    expect(last.headers.get('ratelimit-limit')).toBe('30');
  });
});
