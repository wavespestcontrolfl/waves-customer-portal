/**
 * /rv — printed-card review QR. A scan 302s straight to the Google review form
 * of the nearest office (Cloudflare visitor-location headers). Pins the office
 * picker (pure), the redirect + headers, that bots and a failing counter never
 * change the redirect, and that no location value reaches a log or the counter.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/short-url', () => ({ resolveShortCode: jest.fn() }));

const express = require('express');
const logger = require('../services/logger');
const { resolveShortCode } = require('../services/short-url');
const { WAVES_LOCATIONS } = require('../config/locations');
const router = require('../routes/review-geo-link');
const { pickReviewOfficeId, reviewShortCodeForOffice, REVIEW_GEO_MAX_MILES } = router;

const HUMAN_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1';
const reviewUrl = (id) => WAVES_LOCATIONS.find((l) => l.id === id).googleReviewUrl;
const FALLBACK = 'bradenton';

describe('pickReviewOfficeId', () => {
  test.each(WAVES_LOCATIONS.map((l) => [l.id, l.latitude, l.longitude]))(
    'at the %s office gives that office', (id, latitude, longitude) => {
      expect(pickReviewOfficeId({ country: 'US', latitude, longitude })).toBe(id);
    });

  test.each([
    ['parrish', 27.60, -82.40],
    ['sarasota', 27.30, -82.50],
    ['venice', 27.05, -82.38],
  ])('near %s gives %s (header strings, no country)', (id, lat, lng) => {
    expect(pickReviewOfficeId({ latitude: String(lat), longitude: String(lng) })).toBe(id);
  });

  test('a Tampa point (carrier IP) is more than the cap from every office: fallback', () => {
    expect(REVIEW_GEO_MAX_MILES).toBe(20);
    expect(pickReviewOfficeId({ country: 'US', latitude: '27.95', longitude: '-82.46' })).toBe(FALLBACK);
  });

  test.each([
    ['all missing', {}],
    ['undefined input', undefined],
    ['empty strings', { country: '', latitude: '', longitude: '' }],
    ['blank strings', { latitude: '  ', longitude: '  ' }],
    ['non-numeric', { latitude: 'abc', longitude: 'xyz' }],
    ['NaN', { latitude: NaN, longitude: NaN }],
    ['Infinity', { latitude: Infinity, longitude: -82.4 }],
    ['one coordinate missing', { latitude: '27.5698' }],
    ['latitude out of range', { latitude: '91', longitude: '-82.4265' }],
    ['longitude out of range', { latitude: '27.5698', longitude: '-190' }],
    ['null values', { latitude: null, longitude: null }],
    ['boolean values', { latitude: true, longitude: true }],
  ])('%s gives the fallback', (_label, input) => {
    expect(pickReviewOfficeId(input)).toBe(FALLBACK);
  });

  test.each(['CA', 'MX', 'T1', 'xx', 'gb'])(
    'non-US country %s with valid Florida coordinates gives the fallback', (country) => {
      expect(pickReviewOfficeId({ country, latitude: 27.0870, longitude: -82.4046 })).toBe(FALLBACK);
    });

  test('lowercase us is US', () => {
    expect(pickReviewOfficeId({ country: 'us', latitude: 27.0870, longitude: -82.4046 })).toBe('venice');
  });
});

describe('reviewShortCodeForOffice', () => {
  test('one reserved code per office id, all valid /l codes', () => {
    for (const { id } of WAVES_LOCATIONS) {
      expect(reviewShortCodeForOffice(id)).toBe(`review-${id}`);
      expect(reviewShortCodeForOffice(id)).toMatch(/^[a-z0-9-]{3,80}$/);
    }
  });
});

describe('GET /rv', () => {
  let server;
  let base;
  beforeAll((done) => {
    const app = express();
    app.use('/rv', router);
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
  });
  afterAll((done) => { server.close(done); });
  beforeEach(() => {
    resolveShortCode.mockReset();
    resolveShortCode.mockResolvedValue('https://unused.example.test');
    logger.error.mockClear();
  });

  const hit = async (headers = {}, path = '/rv') => {
    const res = await fetch(`${base}${path}`, { redirect: 'manual', headers: { 'user-agent': HUMAN_UA, ...headers } });
    await new Promise((r) => setImmediate(r)); // the counter is fire-and-forget
    return res;
  };

  test.each([
    ['parrish', { 'cf-ipcountry': 'US', 'cf-iplatitude': '27.5698', 'cf-iplongitude': '-82.4265' }],
    ['venice', { 'cf-ipcountry': 'US', 'cf-iplatitude': '27.0870', 'cf-iplongitude': '-82.4046' }],
    ['sarasota', { 'cf-ipcountry': 'US', 'cf-iplatitude': '27.3333', 'cf-iplongitude': '-82.3736' }],
    ['bradenton', { 'cf-ipcountry': 'US', 'cf-iplatitude': '27.4186', 'cf-iplongitude': '-82.4186' }],
  ])('302 to the %s review form for its headers, counted on its own code', async (id, headers) => {
    const res = await hit(headers);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(reviewUrl(id));
    expect(resolveShortCode).toHaveBeenCalledTimes(1);
    expect(resolveShortCode.mock.calls[0][0]).toBe(`review-${id}`);
  });

  test('no headers: 302 to the fallback office', async () => {
    const res = await hit();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(reviewUrl(FALLBACK));
    expect(resolveShortCode.mock.calls[0][0]).toBe(`review-${FALLBACK}`);
  });

  test('Tampa and a non-US country both land on the fallback', async () => {
    const tampa = await hit({ 'cf-ipcountry': 'US', 'cf-iplatitude': '27.95', 'cf-iplongitude': '-82.46' });
    expect(tampa.headers.get('location')).toBe(reviewUrl(FALLBACK));
    const abroad = await hit({ 'cf-ipcountry': 'CA', 'cf-iplatitude': '27.0870', 'cf-iplongitude': '-82.4046' });
    expect(abroad.headers.get('location')).toBe(reviewUrl(FALLBACK));
  });

  test('the redirect is never cached and carries the privacy headers; a trailing slash works', async () => {
    const res = await hit({}, '/rv/');
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('a bot user agent still redirects but is not counted', async () => {
    const res = await hit({ 'user-agent': 'Slackbot-LinkExpanding 1.0', 'cf-iplatitude': '27.5698', 'cf-iplongitude': '-82.4265' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(reviewUrl('parrish'));
    expect(resolveShortCode).not.toHaveBeenCalled();
  });

  test('a rejecting counter still redirects to the right office', async () => {
    resolveShortCode.mockRejectedValue(new Error('db down'));
    const res = await hit({ 'cf-iplatitude': '27.0870', 'cf-iplongitude': '-82.4046' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(reviewUrl('venice'));
  });

  test('a synchronously throwing counter still redirects', async () => {
    resolveShortCode.mockImplementation(() => { throw new Error('boom'); });
    const res = await hit({ 'cf-iplatitude': '27.0870', 'cf-iplongitude': '-82.4046' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(reviewUrl('venice'));
  });

  test('a missing short-code row (resolveShortCode returns null) changes nothing', async () => {
    resolveShortCode.mockResolvedValue(null);
    const res = await hit({ 'cf-iplatitude': '27.5698', 'cf-iplongitude': '-82.4265' });
    expect(res.headers.get('location')).toBe(reviewUrl('parrish'));
  });

  test('no location value, client IP or user agent is passed to the counter or to a log of this route', async () => {
    await hit({
      'cf-ipcountry': 'US', 'cf-region-code': 'FL', 'cf-iplatitude': '27.5698', 'cf-iplongitude': '-82.4265',
      'x-forwarded-for': '203.0.113.9', 'user-agent': 'Mozilla/5.0 (iPhone; scan-probe-ua)',
    });
    const [code, opts] = resolveShortCode.mock.calls[0];
    expect(code).toBe('review-parrish');
    // Only the staff-preview switch goes to the counter: with no ip and no
    // userAgent it stores neither on the code row nor on the click row.
    expect(Object.keys(opts)).toEqual(['recordClick']);
    const everything = JSON.stringify([resolveShortCode.mock.calls, logger.error.mock.calls, logger.info.mock.calls]);
    expect(everything).not.toMatch(/27\.5698|82\.4265|203\.0\.113\.9|scan-probe-ua/);
  });
});
