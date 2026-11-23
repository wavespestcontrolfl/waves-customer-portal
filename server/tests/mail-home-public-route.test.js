/**
 * GET /api/public/home/:token (routes/mail-home-public.js): the gate, the token format, the 404 that is the same for
 * every miss, the exact payload keys, the privacy headers on every outcome, and when a view is counted. The service is
 * mocked here; services/mail/home-page.js has its own test (mail-home-page.test.js) and a PostgreSQL suite.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'home-page-test-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../config/feature-gates', () => ({ mailHomePageLive: jest.fn(() => true) }));
jest.mock('../services/mail/home-page', () => ({ getHomePage: jest.fn() }));

const express = require('express');
const { mailHomePageLive } = require('../config/feature-gates');
const { getHomePage } = require('../services/mail/home-page');

const TOKEN = '0123456789abcdef0123456789abcdef';
const PAGE = {
  address: { line1: '101 EXAMPLE TRL', city: 'SAMPLETON', zip: '34212' },
  price: { monthly: 52.25, annual: 627, setupFee: 0, pricedAt: '2026-11-22T22:00:00.000Z' },
  plan: 'pest_quarterly',
};

let server;
let base;

beforeAll((done) => {
  const app = express();
  const route = require('../routes/mail-home-public');
  // As in server/index.js: the guard first, then a stand-in for the global /api limiter that always refuses the path
  // /limited-<token>, then the router.
  app.use('/api/public/home', route.preLimiterGuard);
  app.use('/api/public/home', (req, res, next) => (req.query.globalLimit === '1' ? res.status(429).json({ error: 'limited' }) : next()));
  app.use('/api/public/home', route);
  app.use((err, req, res, next) => {
    res.status(500).json({ error: 'Server error' });
  });
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => { server.close(done); });

beforeEach(() => {
  mailHomePageLive.mockReset().mockReturnValue(true);
  getHomePage.mockReset().mockResolvedValue(PAGE);
});

const get = (path, headers) => fetch(`${base}${path}`, { headers });
const expectPrivate = (res) => {
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
};

describe('GET /api/public/home/:token', () => {
  test('gate off: the 404 an unknown token gets, no lookup, private headers', async () => {
    mailHomePageLive.mockReturnValue(false);
    const off = await get(`/api/public/home/${TOKEN}`);
    expect(off.status).toBe(404);
    expect(await off.json()).toEqual({ error: 'Not found' });
    expectPrivate(off);
    expect(getHomePage).not.toHaveBeenCalled();

    // No oracle: the gate-off body and headers are the ones an unknown token gets with the gate on.
    mailHomePageLive.mockReturnValue(true);
    getHomePage.mockResolvedValue(null);
    const unknown = await get(`/api/public/home/${TOKEN}`);
    expect(unknown.status).toBe(off.status);
    expect(await unknown.json()).toEqual({ error: 'Not found' });
    expectPrivate(unknown);
  });

  test('a malformed token is a 404 before any lookup', async () => {
    getHomePage.mockResolvedValue(null);
    for (const bad of ['short', 'ABCDEF0123456789ABCDEF0123456789', `${TOKEN}0`, 'g'.repeat(32)]) {
      const res = await get(`/api/public/home/${bad}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expectPrivate(res);
    }
  });

  test('an unknown token is a 404', async () => {
    getHomePage.mockResolvedValue(null);
    const res = await get(`/api/public/home/${TOKEN}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expectPrivate(res);
  });

  test('a found home answers with exactly address, price and plan, and private headers', async () => {
    const res = await get(`/api/public/home/${TOKEN}`, { 'user-agent': 'Mozilla/5.0 (iPhone) Safari' });
    expect(res.status).toBe(200);
    expectPrivate(res);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['address', 'plan', 'price']);
    expect(Object.keys(body.address).sort()).toEqual(['city', 'line1', 'zip']);
    expect(Object.keys(body.price).sort()).toEqual(['annual', 'monthly', 'pricedAt', 'setupFee']);
    expect(body).toEqual(PAGE);
    expect(getHomePage).toHaveBeenCalledWith(TOKEN, { recordView: true });
  });

  test('a link-preview or scanner user agent reads the page without counting a view', async () => {
    for (const ua of ['Slackbot-LinkExpanding 1.0', 'WhatsApp/2.23', 'curl/8.4.0', 'facebookexternalhit/1.1']) {
      getHomePage.mockClear();
      const res = await get(`/api/public/home/${TOKEN}`, { 'user-agent': ua });
      expect(res.status).toBe(200);
      expect(getHomePage).toHaveBeenCalledWith(TOKEN, { recordView: false });
    }
  });

  test('a staff browser (waves_admin marker cookie) does not count a view', async () => {
    const jwt = require('jsonwebtoken');
    const config = require('../config');
    const marker = jwt.sign({ kind: 'admin_marker' }, config.jwt.secret);
    const res = await get(`/api/public/home/${TOKEN}`, { 'user-agent': 'Mozilla/5.0 Safari', cookie: `waves_admin=${marker}` });
    expect(res.status).toBe(200);
    expect(getHomePage).toHaveBeenCalledWith(TOKEN, { recordView: false });
  });

  test('a service error answers 500 itself and logs only the error code, never the message with the token', async () => {
    const logger = require('../services/logger');
    logger.error.mockClear();
    getHomePage.mockRejectedValue(Object.assign(new Error(`select * from mail_prospects where page_token = '${TOKEN}'`), { code: '57P01' }));
    const res = await get(`/api/public/home/${TOKEN}`);
    expect(res.status).toBe(500);
    expectPrivate(res);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain('mail_prospects');
    expect(body).not.toContain(TOKEN);
    expect(logger.error).toHaveBeenCalledWith('[mail-home-public] page read failed (code=57P01)');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(TOKEN);
  });

  test('gate off: the guard answers 404 before the global limiter could answer 429', async () => {
    mailHomePageLive.mockReturnValue(false);
    const res = await get(`/api/public/home/${TOKEN}?globalLimit=1`);
    expect(res.status).toBe(404);
    expectPrivate(res);
    mailHomePageLive.mockReturnValue(true);
    const live = await get(`/api/public/home/${TOKEN}?globalLimit=1`);
    expect(live.status).toBe(429);
    expectPrivate(live);
  });

  test('a bad percent escape, another path or another method is the same 404, never a 500', async () => {
    for (const path of ['/%E0%A4%A', `/${TOKEN}/extra`, '/', '']) {
      const res = await get(`/api/public/home${path}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expectPrivate(res);
    }
    const post = await fetch(`${base}/api/public/home/${TOKEN}`, { method: 'POST' });
    expect(post.status).toBe(404);
    expect(getHomePage).not.toHaveBeenCalled();
  });

  test('a HEAD request reads without counting a view', async () => {
    const res = await fetch(`${base}/api/public/home/${TOKEN}`, { method: 'HEAD', headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Safari' } });
    expect(res.status).toBe(200);
    expect(getHomePage).toHaveBeenCalledWith(TOKEN, { recordView: false });
  });

  test('the route carries a rate limiter (standard headers) and the 429 keeps the private headers', async () => {
    const res = await get(`/api/public/home/${TOKEN}`);
    expect(res.headers.get('ratelimit-limit') || res.headers.get('ratelimit')).toBeTruthy();
    // 60 a minute: the 61st read from this client is refused.
    let last;
    for (let i = 0; i < 61; i += 1) last = await get(`/api/public/home/${TOKEN}`);
    expect(last.status).toBe(429);
    expectPrivate(last);
  });
});
