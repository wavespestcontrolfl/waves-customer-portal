/**
 * GET /go/:slug (routes/mail-home-go.js): the short typed address on the new-home postcard. The gate, the slug shape and
 * letter case, the live-row rule, the one redirect every dead slug gets, the privacy headers on every outcome, the limiter,
 * and the hand-off of the outside-link codes to the router mounted after it. The table read is mocked here; the real SQL
 * runs in mail-prospect-store-postgres.test.js.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'home-go-test-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ mailHomePageLive: jest.fn(() => true) }));
const mockFirst = jest.fn();
const mockWhere = jest.fn();
const mockWhereIn = jest.fn();
jest.mock('../models/db', () => jest.fn(() => ({
  where: (...args) => { mockWhere(...args); return { whereIn: (...rest) => { mockWhereIn(...rest); return { first: (...cols) => mockFirst(...cols) }; } }; },
})));
jest.mock('../services/outlink-tracking', () => ({ CODE_RE: /^[a-f0-9]{20}$/ }));

const express = require('express');
const { mailHomePageLive } = require('../config/feature-gates');
const logger = require('../services/logger');

const TOKEN = '0123456789abcdef0123456789abcdef';
const SITE = 'https://www.wavespestcontrol.com/';
const OUTSIDE_CODE = '0123456789abcdef0123';

let server;
let base;

beforeAll((done) => {
  const app = express();
  app.set('trust proxy', true);
  // As in server/index.js: this router first, the outside-link router (a stand-in here) after it.
  app.use('/go', require('../routes/mail-home-go'));
  app.use('/go', (req, res) => res.status(200).send(`outside-link-router ${req.path}`));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

beforeEach(() => {
  mailHomePageLive.mockReset().mockReturnValue(true);
  mockFirst.mockReset().mockResolvedValue({ page_token: TOKEN });
  mockWhere.mockClear();
  mockWhereIn.mockClear();
  logger.error.mockClear();
});

let clientSeq = 0;
const freshIp = () => { clientSeq += 1; return { 'x-forwarded-for': `10.8.${Math.floor(clientSeq / 250)}.${clientSeq % 250}` }; };
const get = (path, headers = freshIp(), method = 'GET') => fetch(`${base}${path}`, { redirect: 'manual', method, headers });
const expectPrivate = (res) => {
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
};
const expectSite = (res) => {
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe(SITE);
  expectPrivate(res);
};

describe('GET /go/:slug', () => {
  test('a live slug redirects to the home page /h/<token>, looked up by the lowercase slug on the new-home list', async () => {
    const res = await get('/go/101-example');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/h/${TOKEN}`);
    expectPrivate(res);
    expect(mockWhere).toHaveBeenCalledWith({ page_slug: '101-example', list_key: 'new_home' });
    expect(mockWhereIn).toHaveBeenCalledWith('status', ['eligible', 'held_back']);
    expect(mockFirst).toHaveBeenCalledWith('page_token');
  });

  test('letter case and a trailing slash: the same home', async () => {
    for (const path of ['/go/101-EXAMPLE', '/go/101-Example/', '/go/101-example/', '/go/4512-n-river-oaks', '/go/101-example-34211']) {
      const res = await get(path);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`/h/${TOKEN}`);
    }
    expect(mockWhere).toHaveBeenCalledWith({ page_slug: '101-example', list_key: 'new_home' });
    expect(mockWhere).toHaveBeenCalledWith({ page_slug: '101-example-34211', list_key: 'new_home' });
  });

  test('HEAD redirects the same way', async () => {
    const res = await get('/go/101-example', freshIp(), 'HEAD');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/h/${TOKEN}`);
  });

  test('gate off: the marketing site, with no table read', async () => {
    mailHomePageLive.mockReturnValue(false);
    expectSite(await get('/go/101-example'));
    expect(mockFirst).not.toHaveBeenCalled();
  });

  test('unknown slug, or a row that is not live or not on the list (no row): the marketing site', async () => {
    mockFirst.mockResolvedValue(undefined);
    expectSite(await get('/go/999-nowhere'));
    expect(mockFirst).toHaveBeenCalledTimes(1);
  });

  test('a stored token that is not 32 hex is never put in a Location header', async () => {
    mockFirst.mockResolvedValue({ page_token: 'not-a-token' });
    expectSite(await get('/go/101-example'));
    mockFirst.mockResolvedValue({ page_token: null });
    expectSite(await get('/go/101-example'));
  });

  test.each([
    ['/go/'], ['/go'], ['/go/example'], ['/go/example-101'], ['/go/101'], ['/go/101-'], ['/go/-101-example'],
    ['/go/101--example'], ['/go/101-exam_ple'], ['/go/101-example/extra'], ['/go/101-%2e%2e'], ['/go/101-example%0d%0a'],
    ['/go/101-ex%'], ['/go/12a-example'], [`/go/101-${'a'.repeat(70)}`], ['/go/101-é'],
  ])('bad shape %s: the marketing site, with no table read', async (path) => {
    expectSite(await get(path));
    expect(mockFirst).not.toHaveBeenCalled();
  });

  test('a lookup that fails still redirects to the marketing site and logs only the error code', async () => {
    mockFirst.mockRejectedValue(Object.assign(new Error('select * from mail_prospects where page_slug = $1'), { code: '57014' }));
    expectSite(await get('/go/101-example'));
    expect(logger.error).toHaveBeenCalledTimes(1);
    const line = logger.error.mock.calls[0][0];
    expect(line).toContain('57014');
    expect(line).not.toMatch(/select|101-example/i);
  });

  test('an outside-link code (20 hex) goes on to the next router, whatever the gate says, without a table read', async () => {
    for (const gate of [true, false]) {
      mailHomePageLive.mockReturnValue(gate);
      const res = await get(`/go/${OUTSIDE_CODE}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(`outside-link-router /${OUTSIDE_CODE}`);
    }
    expect((await get(`/go/${OUTSIDE_CODE.toUpperCase()}`)).status).toBe(200);
    expect(mockFirst).not.toHaveBeenCalled();
  });

  test('a method other than GET or HEAD finds no handler here and goes on', async () => {
    const res = await fetch(`${base}/go/101-example`, { method: 'POST', headers: freshIp(), redirect: 'manual' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('outside-link-router /101-example');
    expect(mockFirst).not.toHaveBeenCalled();
  });

  test('the limiter: 60 a minute for one client, then 429 with the privacy headers; another client is not held', async () => {
    const client = { 'x-forwarded-for': '10.99.0.1' };
    let last;
    for (let i = 0; i < 61; i += 1) last = await get('/go/101-example', client);
    expect(last.status).toBe(429);
    expectPrivate(last);
    expect((await get('/go/101-example', freshIp())).status).toBe(302);
  });
});
