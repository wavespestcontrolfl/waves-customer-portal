/**
 * First-time blog visitors get their own forecast city (owner ruling
 * 2026-09-27), from Cloudflare's visitor-location request headers — an
 * IP-based estimate the zone's "Add visitor location headers" Managed
 * Transform adds. Only a visitor geolocated in Florida gets a city (the
 * nearest curated one, even past the metro radius — Daytona → Orlando);
 * anyone else (California, New York, south Georgia) gets null so the widget
 * keeps its Bradenton default. The route returns only the slug, logs
 * nothing, and is never cached (it differs per visitor).
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const { nearestFloridaLocation } = require('../services/pest-forecast/locations');
const router = require('../routes/public-pest-forecast');

const visitor = (regionCode, latitude, longitude, country = 'US') => ({ country, regionCode, latitude, longitude });
const slugFor = (v) => nearestFloridaLocation(v)?.slug ?? null;

describe('nearestFloridaLocation', () => {
  test.each([
    ['Bradenton', visitor('FL', '27.4989', '-82.5748'), 'bradenton-fl'],
    ['Lakewood Ranch', visitor('FL', '27.4225', '-82.4082'), 'lakewood-ranch-fl'],
    ['Fort Myers', visitor('FL', '26.6406', '-81.8723'), 'fort-myers-fl'],
    ['Daytona Beach (no curated city within 40 mi)', visitor('FL', '29.2108', '-81.0228'), 'orlando-fl'],
    ['Pensacola (far Panhandle)', visitor('FL', '30.4213', '-87.2169'), 'tallahassee-fl'],
    ['lower-case country/region values', visitor('fl', '27.4989', '-82.5748', 'us'), 'bradenton-fl'],
  ])('a Florida visitor in %s gets the nearest curated city', (_label, v, expected) => {
    expect(slugFor(v)).toBe(expected);
  });

  test.each([
    ['California', visitor('CA', '37.7749', '-122.4194')],
    ['New York', visitor('NY', '40.7128', '-74.0060')],
    ['south Georgia, near Tallahassee', visitor('GA', '30.8327', '-83.2785')],
    ['outside the US', visitor('ON', '43.6532', '-79.3832', 'CA')],
  ])('a visitor in %s gets null (the widget keeps its default)', (_label, v) => {
    expect(slugFor(v)).toBeNull();
  });

  test.each([
    ['no headers at all', {}],
    ['blank coordinates', visitor('FL', '', '')],
    ['non-numeric coordinates', visitor('FL', 'abc', '-82.57')],
    ['out-of-range coordinates', visitor('FL', '95', '-82.57')],
    ['a Florida region with New York coordinates (contradictory estimate)', visitor('FL', '40.7128', '-74.0060')],
  ])('%s → null, never a guess', (_label, v) => {
    expect(slugFor(v)).toBeNull();
  });
});

describe('GET /api/public/pest-forecast/nearest', () => {
  function nearestHandler() {
    const layer = router.stack.find((l) => l.route && l.route.path === '/nearest' && l.route.methods.get);
    return layer.route.stack[0].handle;
  }

  function respond(headers) {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const req = { get: (name) => lower[String(name).toLowerCase()] };
    const res = { set: jest.fn(), json: jest.fn() };
    nearestHandler()(req, res);
    return {
      body: res.json.mock.calls[0][0],
      cacheControl: res.set.mock.calls.find(([name]) => name === 'Cache-Control')?.[1],
    };
  }

  beforeEach(() => jest.clearAllMocks());

  test('a Florida visitor gets their nearest city slug, never cached, nothing logged', () => {
    const out = respond({
      'CF-IPCountry': 'US', 'CF-Region-Code': 'FL', 'CF-IPLatitude': '27.5214', 'CF-IPLongitude': '-82.5723',
    });

    expect(out.body).toEqual({ location: 'palmetto-fl' });
    expect(out.cacheControl).toBe('private, no-store');
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  test.each([
    ['an out-of-state visitor', { 'cf-ipcountry': 'US', 'cf-region-code': 'CA', 'cf-iplatitude': '37.7749', 'cf-iplongitude': '-122.4194' }],
    ['a request without location headers (not via Cloudflare)', {}],
  ])('%s gets { location: null }', (_label, headers) => {
    const out = respond(headers);

    expect(out.body).toEqual({ location: null });
    expect(out.cacheControl).toBe('private, no-store');
  });
});
