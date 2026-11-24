/**
 * GET /nh/:slug (routes/mail-home-short-link.js): the short typed address on the new-home postcard. The gate, the slug
 * shape and letter case, the live-row rule, the one redirect every dead slug gets, the privacy headers on every outcome
 * and the limiter. The table read is mocked here; the real SQL runs in mail-prospect-store-postgres.test.js.
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

const express = require('express');
const { mailHomePageLive } = require('../config/feature-gates');
const logger = require('../services/logger');

const TOKEN = '0123456789abcdef0123456789abcdef';
const SITE = 'https://www.wavespestcontrol.com/';

let server;
let base;

beforeAll((done) => {
  const app = express();
  app.set('trust proxy', true);
  // As in server/index.js.
  app.use('/nh', require('../routes/mail-home-short-link'));
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

describe('GET /nh/:slug', () => {
  test('a live slug redirects to the home page /h/<token>, looked up by the lowercase slug on the new-home list', async () => {
    const res = await get('/nh/101-example');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/h/${TOKEN}`);
    expectPrivate(res);
    expect(mockWhere).toHaveBeenCalledWith({ page_slug: '101-example', list_key: 'new_home' });
    expect(mockWhereIn).toHaveBeenCalledWith('status', ['eligible', 'held_back']);
    expect(mockFirst).toHaveBeenCalledWith('page_token');
  });

  test('letter case and a trailing slash: the same home', async () => {
    for (const path of ['/nh/101-EXAMPLE', '/nh/101-Example/', '/nh/101-example/', '/nh/4512-n-river-oaks', '/nh/101-example-34211']) {
      const res = await get(path);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`/h/${TOKEN}`);
    }
    expect(mockWhere).toHaveBeenCalledWith({ page_slug: '101-example', list_key: 'new_home' });
    expect(mockWhere).toHaveBeenCalledWith({ page_slug: '101-example-34211', list_key: 'new_home' });
  });

  test('HEAD redirects the same way', async () => {
    const res = await get('/nh/101-example', freshIp(), 'HEAD');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/h/${TOKEN}`);
  });

  test('gate off: the marketing site, with no table read', async () => {
    mailHomePageLive.mockReturnValue(false);
    expectSite(await get('/nh/101-example'));
    expect(mockFirst).not.toHaveBeenCalled();
  });

  test('unknown slug, or a row that is not live or not on the list (no row): the marketing site', async () => {
    mockFirst.mockResolvedValue(undefined);
    expectSite(await get('/nh/999-nowhere'));
    expect(mockFirst).toHaveBeenCalledTimes(1);
  });

  test('a stored token that is not 32 hex is never put in a Location header', async () => {
    mockFirst.mockResolvedValue({ page_token: 'not-a-token' });
    expectSite(await get('/nh/101-example'));
    mockFirst.mockResolvedValue({ page_token: null });
    expectSite(await get('/nh/101-example'));
  });

  test.each([
    ['/nh/'], ['/nh'], ['/nh/example'], ['/nh/example-101'], ['/nh/101'], ['/nh/101-'], ['/nh/-101-example'],
    ['/nh/101--example'], ['/nh/101-exam_ple'], ['/nh/101-example/extra'], ['/nh/101-%2e%2e'], ['/nh/101-example%0d%0a'],
    ['/nh/101-ex%'], ['/nh/12a-example'], [`/nh/101-${'a'.repeat(70)}`], ['/nh/101-é'],
  ])('bad shape %s: the marketing site, with no table read', async (path) => {
    expectSite(await get(path));
    expect(mockFirst).not.toHaveBeenCalled();
  });

  test('a lookup that fails still redirects to the marketing site and logs only the error code', async () => {
    mockFirst.mockRejectedValue(Object.assign(new Error('select * from mail_prospects where page_slug = $1'), { code: '57014' }));
    expectSite(await get('/nh/101-example'));
    expect(logger.error).toHaveBeenCalledTimes(1);
    const line = logger.error.mock.calls[0][0];
    expect(line).toContain('57014');
    expect(line).not.toMatch(/select|101-example/i);
  });

  test('a method other than GET or HEAD finds no handler: 404, no table read', async () => {
    const res = await fetch(`${base}/nh/101-example`, { method: 'POST', headers: freshIp(), redirect: 'manual' });
    expect(res.status).toBe(404);
    expect(mockFirst).not.toHaveBeenCalled();
  });

  test('the limiter: 60 a minute for one client, then 429 with the privacy headers; another client is not held', async () => {
    const client = { 'x-forwarded-for': '10.99.0.1' };
    let last;
    for (let i = 0; i < 61; i += 1) last = await get('/nh/101-example', client);
    expect(last.status).toBe(429);
    expectPrivate(last);
    expect((await get('/nh/101-example', freshIp())).status).toBe(302);
  });
});
