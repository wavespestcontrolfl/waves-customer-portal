/**
 * GET /api/public/home/:token, GET /:token/times and POST /:token/book (routes/mail-home-public.js): the gate, the token
 * format, the 404 that is the same for every miss, the exact payload keys, the privacy headers on every outcome, when a
 * view is counted, which paths and methods the guard lets through and the limiters. The services are mocked here;
 * services/mail/home-page.js and home-book.js have their own tests (mail-home-page.test.js, mail-home-book.test.js).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'home-page-test-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../config/feature-gates', () => ({ mailHomePageLive: jest.fn(() => true) }));
jest.mock('../services/mail/home-page', () => ({ getHomePage: jest.fn() }));
jest.mock('../services/mail/home-book', () => ({ getHomeTimes: jest.fn(), bookHome: jest.fn() }));

const express = require('express');
const { mailHomePageLive } = require('../config/feature-gates');
const { getHomePage } = require('../services/mail/home-page');
const { getHomeTimes, bookHome } = require('../services/mail/home-book');

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
  // The times and book tests give each test its own client address (x-forwarded-for), so one test's requests never
  // use another's limiter bucket. A request without the header keeps the socket address.
  app.set('trust proxy', true);
  const route = require('../routes/mail-home-public');
  // As in server/index.js: one mount, the guard first, then the router (its own limiter and the route).
  app.use('/api/public/home', route.preLimiterGuard, route);
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
  getHomeTimes.mockReset();
  bookHome.mockReset();
});

const get = (path, headers) => fetch(`${base}${path}`, { headers });
const expectPrivate = (res) => {
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
};

let clientSeq = 0;
const freshIp = () => { clientSeq += 1; return `10.9.${Math.floor(clientSeq / 250)}.${clientSeq % 250}`; };
const OFFERS = [
  { date: '2026-12-02', start_time: '09:00', end_time: '10:00', start_label: '9:00 AM', end_label: '10:00 AM', technician_id: null, slot_sig: 'sig-1' },
];
const BOOK_BODY = { offer: OFFERS[0], name: 'Sample Person', phone: '(941) 555-0142', email: 'sample@example.com' };
const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

describe('GET /:token/times and POST /:token/book', () => {
  test('gate off: all three answer the 404 an unknown token gets, before any service or limiter', async () => {
    mailHomePageLive.mockReturnValue(false);
    const ip = { 'x-forwarded-for': freshIp() };
    const bodies = [];
    for (const res of [
      await get(`/api/public/home/${TOKEN}`, ip),
      await get(`/api/public/home/${TOKEN}/times`, ip),
      await post(`/api/public/home/${TOKEN}/book`, BOOK_BODY, ip),
    ]) {
      expect(res.status).toBe(404);
      expectPrivate(res);
      bodies.push(await res.json());
    }
    expect(bodies).toEqual([{ error: 'Not found' }, { error: 'Not found' }, { error: 'Not found' }]);
    expect(getHomePage).not.toHaveBeenCalled();
    expect(getHomeTimes).not.toHaveBeenCalled();
    expect(bookHome).not.toHaveBeenCalled();
  });

  test('a malformed token, another path or another method never reaches a service', async () => {
    const ip = { 'x-forwarded-for': freshIp() };
    const attempts = [
      get('/api/public/home/short/times', ip),
      get(`/api/public/home/${TOKEN.toUpperCase()}/times`, ip),
      post('/api/public/home/short/book', BOOK_BODY, ip),
      post(`/api/public/home/${TOKEN}0/book`, BOOK_BODY, ip),
      post(`/api/public/home/${TOKEN}/times`, BOOK_BODY, ip),
      get(`/api/public/home/${TOKEN}/book`, ip),
      fetch(`${base}/api/public/home/${TOKEN}/book`, { method: 'PUT', headers: ip }),
      fetch(`${base}/api/public/home/${TOKEN}/book`, { method: 'DELETE', headers: ip }),
      fetch(`${base}/api/public/home/${TOKEN}/times`, { method: 'HEAD', headers: ip }),
      get(`/api/public/home/${TOKEN}/book/extra`, ip),
      get(`/api/public/home/${TOKEN}/other`, ip),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
      expectPrivate(res);
    }
    expect(getHomeTimes).not.toHaveBeenCalled();
    expect(bookHome).not.toHaveBeenCalled();
  });

  test('an unknown token (or a home with no price) is the same 404 on times and on book', async () => {
    getHomeTimes.mockResolvedValue(null);
    bookHome.mockResolvedValue(null);
    const ip = { 'x-forwarded-for': freshIp() };
    const times = await get(`/api/public/home/${TOKEN}/times`, ip);
    const book = await post(`/api/public/home/${TOKEN}/book`, BOOK_BODY, ip);
    for (const res of [times, book]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expectPrivate(res);
    }
  });

  test('times answers the offers the service gives, in its order, with private headers', async () => {
    const later = { ...OFFERS[0], date: '2026-12-03', slot_sig: 'sig-2' };
    getHomeTimes.mockResolvedValue({ offers: [OFFERS[0], later] });
    const res = await get(`/api/public/home/${TOKEN}/times`, { 'x-forwarded-for': freshIp() });
    expect(res.status).toBe(200);
    expectPrivate(res);
    expect(await res.json()).toEqual({ offers: [OFFERS[0], later] });
    expect(getHomeTimes).toHaveBeenCalledWith(TOKEN);
  });

  test('times answers 503 not_available when /book is off or the address has no pin', async () => {
    getHomeTimes.mockResolvedValue({ error: 'not_available' });
    const res = await get(`/api/public/home/${TOKEN}/times`, { 'x-forwarded-for': freshIp() });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'not_available' });
    expectPrivate(res);
  });

  test('book passes the parsed JSON body and answers the service status and body', async () => {
    bookHome.mockResolvedValue({ status: 200, body: { booked: true, date: '2026-12-02', window: { start: '09:00', end: '10:00' } } });
    const ip = { 'x-forwarded-for': freshIp() };
    const ok = await post(`/api/public/home/${TOKEN}/book`, BOOK_BODY, ip);
    expect(ok.status).toBe(200);
    expectPrivate(ok);
    expect(await ok.json()).toEqual({ booked: true, date: '2026-12-02', window: { start: '09:00', end: '10:00' } });
    expect(bookHome).toHaveBeenCalledWith(TOKEN, BOOK_BODY);

    bookHome.mockResolvedValue({ status: 409, body: { error: 'slot_taken', offers: OFFERS } });
    const taken = await post(`/api/public/home/${TOKEN}/book`, BOOK_BODY, ip);
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: 'slot_taken', offers: OFFERS });
  });

  test('book: a body that is not JSON or is too large is invalid_contact; a non-JSON type reads as an empty body', async () => {
    const ip = { 'x-forwarded-for': freshIp() };
    const broken = await post(`/api/public/home/${TOKEN}/book`, '{"name": ', ip);
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ error: 'invalid_contact' });
    expectPrivate(broken);
    const big = await post(`/api/public/home/${TOKEN}/book`, { ...BOOK_BODY, name: 'x'.repeat(5000) }, ip);
    expect(big.status).toBe(400);
    expect(await big.json()).toEqual({ error: 'invalid_contact' });
    expect(bookHome).not.toHaveBeenCalled();

    bookHome.mockResolvedValue({ status: 400, body: { error: 'invalid_contact', field: 'name' } });
    const text = await fetch(`${base}/api/public/home/${TOKEN}/book`, {
      method: 'POST', headers: { 'content-type': 'text/plain', ...ip }, body: JSON.stringify(BOOK_BODY),
    });
    expect(text.status).toBe(400);
    expect(bookHome).toHaveBeenCalledWith(TOKEN, {});
  });

  test('a book or times error answers 500 itself and logs only the error code', async () => {
    const logger = require('../services/logger');
    logger.error.mockClear();
    const ip = { 'x-forwarded-for': freshIp() };
    bookHome.mockRejectedValue(Object.assign(new Error(`insert into customers (phone) values ('9415550142') ${TOKEN}`), { code: '23505' }));
    const book = await post(`/api/public/home/${TOKEN}/book`, BOOK_BODY, ip);
    expect(book.status).toBe(500);
    expectPrivate(book);
    getHomeTimes.mockRejectedValue(Object.assign(new Error('Geocode failed: sample@example.com'), { code: 'ECONNRESET' }));
    const times = await get(`/api/public/home/${TOKEN}/times`, ip);
    expect(times.status).toBe(500);
    expect(JSON.stringify([await book.json(), await times.json()])).not.toContain('customers');
    expect(logger.error).toHaveBeenCalledWith('[mail-home-public] booking failed (code=23505)');
    expect(logger.error).toHaveBeenCalledWith('[mail-home-public] times read failed (code=ECONNRESET)');
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/9415550142|example\.com|0123456789abcdef/);
  });

  test('book is limited to 5 a minute for one client (the 6th is a 429 with private headers); another client is not', async () => {
    bookHome.mockResolvedValue({ status: 400, body: { error: 'invalid_contact', field: 'name' } });
    const ip = { 'x-forwarded-for': freshIp() };
    for (let i = 0; i < 5; i += 1) expect((await post(`/api/public/home/${TOKEN}/book`, BOOK_BODY, ip)).status).toBe(400);
    const sixth = await post(`/api/public/home/${TOKEN}/book`, BOOK_BODY, ip);
    expect(sixth.status).toBe(429);
    expectPrivate(sixth);
    expect(bookHome).toHaveBeenCalledTimes(5);
    expect((await post(`/api/public/home/${TOKEN}/book`, BOOK_BODY, { 'x-forwarded-for': freshIp() })).status).toBe(400);
    // The page read is still open to the limited client.
    expect((await get(`/api/public/home/${TOKEN}`, ip)).status).toBe(200);
  });

  test('times is limited to 15 a minute for one client', async () => {
    getHomeTimes.mockResolvedValue({ offers: OFFERS });
    const ip = { 'x-forwarded-for': freshIp() };
    for (let i = 0; i < 15; i += 1) expect((await get(`/api/public/home/${TOKEN}/times`, ip)).status).toBe(200);
    const last = await get(`/api/public/home/${TOKEN}/times`, ip);
    expect(last.status).toBe(429);
    expectPrivate(last);
    expect(getHomeTimes).toHaveBeenCalledTimes(15);
  });
});

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
    // The same headers too: the router limiter's headers are dropped from a 404.
    const names = (res) => [...res.headers.keys()].filter((n) => !['date', 'content-length', 'etag', 'connection', 'keep-alive'].includes(n)).sort();
    expect(names(unknown)).toEqual(names(off));
    expect(names(unknown).some((n) => /ratelimit/i.test(n))).toBe(false);
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

  test('gate off: the guard answers 404 before the route limiter, even for a client the limiter would refuse', async () => {
    // Use up this client's 60 a minute (fewer reads if another test already used some), so the limiter would refuse it.
    let status = 0;
    for (let i = 0; i < 61 && status !== 429; i += 1) status = (await get(`/api/public/home/${TOKEN}`)).status;
    expect(status).toBe(429);
    mailHomePageLive.mockReturnValue(false);
    const res = await get(`/api/public/home/${TOKEN}`);
    expect(res.status).toBe(404);
    expectPrivate(res);
  });
});
