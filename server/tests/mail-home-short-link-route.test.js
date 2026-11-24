/**
 * GET /nh/:slug (routes/mail-home-short-link.js): the short typed address on the new-home postcard. The gate, the slug
 * shape and letter case, the live-row rule, the one redirect every dead slug gets, the privacy headers on every outcome
 * and the limiter. The table read is mocked here; the real SQL runs in mail-prospect-store-postgres.test.js.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'home-go-test-secret';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ mailHomePageLive: jest.fn(() => true) }));
jest.mock('../services/customer-page-views', () => ({ shouldRecord: jest.fn(() => true) }));
const mockFirst = jest.fn();
const mockUpdate = jest.fn();
const mockTimeout = jest.fn();
const mockWrite = jest.fn();
const mockWhereId = jest.fn();
const mockWhere = jest.fn();
const mockWhereIn = jest.fn();
jest.mock('../models/db', () => {
  const db = jest.fn(() => ({
    where: (...args) => {
      // The typed-view write is where({ id }).update(set).timeout(ms, opts); the lookup is where(...).whereIn(...).first(...).
      if (args[0] && args[0].id) {
        mockWhereId(...args);
        return { update: (...set) => { mockUpdate(...set); return { timeout: (...opts) => { mockTimeout(...opts); return mockWrite(); } }; } };
      }
      mockWhere(...args);
      return { whereIn: (...rest) => { mockWhereIn(...rest); return { first: (...cols) => mockFirst(...cols) }; } };
    },
  }));
  db.raw = (sql) => ({ sql });
  return db;
});

const express = require('express');
const { mailHomePageLive } = require('../config/feature-gates');
const logger = require('../services/logger');
const { shouldRecord } = require('../services/customer-page-views');

const TOKEN = '0123456789abcdef0123456789abcdef';
const SITE = 'https://www.wavespestcontrol.com/?utm_source=new_home_postcard&utm_medium=print&utm_campaign=typed_link_miss';

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
  mockFirst.mockReset().mockResolvedValue({ id: 'row-1', page_token: TOKEN });
  mockUpdate.mockReset();
  mockTimeout.mockReset();
  mockWrite.mockReset().mockResolvedValue(1);
  mockWhereId.mockClear();
  shouldRecord.mockReset().mockReturnValue(true);
  mockWhere.mockClear();
  mockWhereIn.mockClear();
  logger.error.mockClear();
  logger.warn.mockClear();
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
    expect(mockFirst).toHaveBeenCalledWith('id', 'page_token');
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

  test('HEAD redirects the same way and counts nothing', async () => {
    const res = await get('/nh/101-example', freshIp(), 'HEAD');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/h/${TOKEN}`);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('a known slug adds one typed view to that home: one atomic UPDATE with a 2 s cancel, nothing about the visitor', async () => {
    const res = await get('/nh/101-example');
    expect(res.status).toBe(302);
    expect(mockWhereId).toHaveBeenCalledWith({ id: 'row-1' });
    expect(mockUpdate).toHaveBeenCalledWith({ page_typed_views: { sql: 'page_typed_views + 1' } });
    expect(mockTimeout).toHaveBeenCalledWith(2000, { cancel: true });
  });

  test('link-preview agents and staff are not counted (shouldRecord false), but still redirected', async () => {
    shouldRecord.mockReturnValue(false);
    const res = await get('/nh/101-example');
    expect(res.headers.get('location')).toBe(`/h/${TOKEN}`);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('the redirect never waits for the count: a write that never finishes still redirects', async () => {
    mockWrite.mockReturnValue(new Promise(() => {}));
    const res = await get('/nh/101-example');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/h/${TOKEN}`);
  });

  test('a failed count still redirects and logs only the error code', async () => {
    mockWrite.mockRejectedValue(Object.assign(new Error('update mail_prospects set page_typed_views ... 101-example'), { code: '57014' }));
    const res = await get('/nh/101-example');
    expect(res.headers.get('location')).toBe(`/h/${TOKEN}`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = logger.warn.mock.calls[0][0];
    expect(line).toContain('57014');
    expect(line).not.toMatch(/update|mail_prospects|101-example/i);
  });

  test('every dead answer carries the typed-link-miss tags (the site address with utm_source=new_home_postcard)', async () => {
    mockFirst.mockResolvedValue(undefined);
    const res = await get('/nh/999-nowhere');
    expect(res.headers.get('location')).toBe(
      'https://www.wavespestcontrol.com/?utm_source=new_home_postcard&utm_medium=print&utm_campaign=typed_link_miss',
    );
    expect(mockUpdate).not.toHaveBeenCalled();
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
    mockFirst.mockResolvedValue({ id: 'row-1', page_token: 'not-a-token' });
    expectSite(await get('/nh/101-example'));
    mockFirst.mockResolvedValue({ id: 'row-1', page_token: null });
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

  test('a method other than GET or HEAD is a 404 with the gate off too, never a redirect', async () => {
    mailHomePageLive.mockReturnValue(false);
    const res = await fetch(`${base}/nh/101-example`, { method: 'POST', headers: freshIp(), redirect: 'manual' });
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
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
