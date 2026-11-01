// GET /api/public/watering-plan (GATE_PUBLIC_WATERING_PLAN): the route's own
// behavior — dark gate before any limiter or work, the per-IP limit, status
// codes, Cache-Control capped at the weather's freshUntil, the 503 fail-soft
// answer — plus the server/index.js pieces the route tests cannot mount
// (gate order, wildcard CORS). The decision and copy are pinned in
// public-watering-plan.test.js.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'watering-plan-test-secret';

jest.mock('../models/db', () => { const m = jest.fn(); m.fn = { now: () => 'now()' }; return m; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-report/application-conditions', () => ({ fetchServiceWeekWeather: jest.fn() }));
jest.mock('../services/irrigation-weekly-email', () => ({ fetchUpcomingWeekForecast: jest.fn() }));

jest.setTimeout(30000);

const fs = require('fs');
const path = require('path');
const express = require('express');
const { fetchServiceWeekWeather } = require('../services/service-report/application-conditions');
const { fetchUpcomingWeekForecast } = require('../services/irrigation-weekly-email');
const { _private: { _clearCache } } = require('../services/public-watering-plan');

const PATH = '/api/public/watering-plan';
const OBSERVED = { rainInches: 0.3, et0Inches: 1.4, rainSource: 'mrms' };
const FORECAST = { rainInches: 0.1, et0Inches: 1.5, days: 7, startDate: '2026-10-28', endDate: '2026-11-01' };
const POLICY_ENV = JSON.stringify({
  maxDaysPerWeek: 1,
  effectiveFrom: '2026-08-27',
  expiresOn: '2027-03-31',
  label: 'SWFWMD Modified Phase III water shortage order',
  source: 'https://www.swfwmd.state.fl.us/the-newsroom/2026/district-extends-modified-phase-iii-water-shortage',
  hoursNote: 'on your assigned day, during your area\'s allowed hours',
  coverage: { counties: ['Manatee', 'Sarasota'], partial: ['Charlotte'] },
});
const CONTRACT_KEYS = ['location', 'asOf', 'week', 'rain', 'forecast', 'need', 'plan', 'restriction', 'rulesUrl', 'text', 'landing', 'brand', 'disclaimer'];

// Only Date is faked, so the sockets and timers keep working.
const ONLY_DATE = { doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] };
const WED_MORNING = new Date('2026-10-28T14:00:00Z'); // 10:00 AM ET
const WED_LATE = new Date('2026-10-29T02:30:00Z'); // 10:30 PM ET: 90 minutes to ET midnight

const saved = { gate: process.env.GATE_PUBLIC_WATERING_PLAN, policy: process.env.IRRIGATION_RESTRICTION_POLICY, nodeEnv: process.env.NODE_ENV };

function appServer() {
  const app = express();
  app.use(PATH, require('../routes/public-watering-plan'));
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
async function withServer(fn) {
  const { server, base } = appServer();
  try { return await fn(base); } finally { await new Promise((r) => server.close(r)); }
}
const get = (base, query = '') => fetch(`${base}${PATH}${query}`);

beforeEach(() => {
  jest.clearAllMocks();
  _clearCache();
  process.env.GATE_PUBLIC_WATERING_PLAN = 'true';
  process.env.IRRIGATION_RESTRICTION_POLICY = POLICY_ENV;
  process.env.NODE_ENV = 'test';
  fetchServiceWeekWeather.mockResolvedValue({ ...OBSERVED, windowClosed: true });
  fetchUpcomingWeekForecast.mockResolvedValue(FORECAST);
  jest.useFakeTimers({ ...ONLY_DATE, now: WED_MORNING });
});
afterEach(() => jest.useRealTimers());
afterAll(() => {
  for (const [key, name] of [['gate', 'GATE_PUBLIC_WATERING_PLAN'], ['policy', 'IRRIGATION_RESTRICTION_POLICY'], ['nodeEnv', 'NODE_ENV']]) {
    if (saved[key] === undefined) delete process.env[name];
    else process.env[name] = saved[key];
  }
});

describe('gate', () => {
  test('dark: the generic 404, no weather fetch', async () => {
    delete process.env.GATE_PUBLIC_WATERING_PLAN;
    await withServer(async (base) => {
      for (const query of ['?location=bradenton-fl', '', '?zip=bad']) {
        const res = await get(base, query);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
      }
    });
    expect(fetchServiceWeekWeather).not.toHaveBeenCalled();
    expect(fetchUpcomingWeekForecast).not.toHaveBeenCalled();
  });

  test('anything but exactly "true" is dark', async () => {
    await withServer(async (base) => {
      for (const value of ['1', 'TRUE', 'on', '']) {
        process.env.GATE_PUBLIC_WATERING_PLAN = value;
        expect((await get(base, '?location=bradenton-fl')).status).toBe(404);
      }
    });
  });

  test('dark: the per-IP limiter never answers, even in production and past its budget', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.GATE_PUBLIC_WATERING_PLAN;
    await withServer(async (base) => {
      for (let i = 0; i < 125; i += 1) {
        expect((await get(base, '?location=bradenton-fl')).status).toBe(404);
      }
    });
  });
});

describe('per-IP limit', () => {
  test('production: 120 requests per 15 minutes, then 429; skipped outside production', async () => {
    process.env.NODE_ENV = 'production';
    await withServer(async (base) => {
      let last;
      for (let i = 0; i < 120; i += 1) {
        last = await get(base, '?location=bradenton-fl');
        expect(last.status).toBe(200);
      }
      expect(last.headers.get('ratelimit-limit')).toBe('120');
      const over = await get(base, '?location=bradenton-fl');
      expect(over.status).toBe(429);
      expect(await over.json()).toMatchObject({ error: 'rate_limited' });
    });
  });
});

describe('GET /', () => {
  test('gate on and weather mocked: 200 with the contract keys', async () => {
    await withServer(async (base) => {
      const res = await get(base, '?location=bradenton-fl&grass=bahia&head=spray&minutes=20&sensor=1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Object.keys(body)).toEqual(CONTRACT_KEYS);
      expect(body.location).toEqual({ slug: 'bradenton-fl', label: 'Bradenton, FL', county: 'Manatee' });
      expect(body.asOf).toBe('2026-10-28');
      expect(body.plan.legalMaxEvents).toBe(1);
      expect(body.restriction.maxDaysPerWeek).toBe(1);
      expect(Object.keys(body.plan)).toEqual(['action', 'events', 'depthInches', 'minutesPerEvent', 'conditionalOnForecast', 'legalMaxEvents']);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
    });
  });

  test('a ZIP request reports the location it resolved to', async () => {
    await withServer(async (base) => {
      const body = await (await get(base, '?zip=34205')).json();
      expect(body.location.slug).toBe('bradenton-fl');
    });
  });

  test('outside coverage: need_only, no event count and no legal maximum on the wire', async () => {
    await withServer(async (base) => {
      const body = await (await get(base, '?location=tampa-fl')).json();
      expect(body.plan).toEqual({
        action: 'need_only', events: null, depthInches: null, minutesPerEvent: null, conditionalOnForecast: false, legalMaxEvents: null,
      });
      expect(body.restriction).toBeNull();
    });
  });

  test('bad params: 400 with a short JSON error, no weather fetch, no caching', async () => {
    const cases = [
      ['', 'location_required'],
      ['?location=nowhere-fl', 'unknown_location'],
      ['?zip=12', 'invalid_zip'],
      ['?zip=90210', 'unsupported_zip'],
      ['?location=bradenton-fl&grass=fescue', 'invalid_grass'],
      ['?location=bradenton-fl&head=drip', 'invalid_head'],
      ['?location=bradenton-fl&head=spray&minutes=0', 'invalid_minutes'],
      ['?location=bradenton-fl&head=spray&minutes=241', 'invalid_minutes'],
      ['?location=bradenton-fl&sensor=yes', 'invalid_sensor'],
      ['?location=a&location=b', 'invalid_location'],
    ];
    await withServer(async (base) => {
      for (const [query, error] of cases) {
        const res = await get(base, query);
        expect([query, res.status]).toEqual([query, 400]);
        const body = await res.json();
        expect(body.error).toBe(error);
        expect(typeof body.message).toBe('string');
        expect(Object.keys(body).sort()).toEqual(['error', 'message']);
        expect(res.headers.get('cache-control')).toBe('no-store');
      }
    });
    expect(fetchServiceWeekWeather).not.toHaveBeenCalled();
  });

  test('Cache-Control: 1h browser / 3h shared, capped at the weather\'s freshUntil measured at send time', async () => {
    await withServer(async (base) => {
      const fresh = await get(base, '?location=bradenton-fl');
      expect(fresh.headers.get('cache-control')).toBe('public, max-age=3600, s-maxage=10800');

      // 10:30 PM ET: the weather is good for 90 more minutes (ET midnight), not 3 hours.
      _clearCache();
      jest.setSystemTime(WED_LATE);
      const late = await get(base, '?location=bradenton-fl');
      expect(late.headers.get('cache-control')).toBe('public, max-age=3600, s-maxage=5400');

      // The cached weather is served 100 minutes later (past ET midnight it is
      // refetched; before it, the lifetime is the seconds left). Re-use at +60 min:
      jest.setSystemTime(new Date(WED_LATE.getTime() + 60 * 60 * 1000));
      const reused = await get(base, '?location=bradenton-fl');
      expect(reused.headers.get('cache-control')).toBe('public, max-age=1800, s-maxage=1800');
    });
  });

  test('a half-missing input shortens the lifetime to the retry window', async () => {
    fetchUpcomingWeekForecast.mockResolvedValue(null);
    await withServer(async (base) => {
      const res = await get(base, '?location=bradenton-fl');
      expect(res.status).toBe(200);
      expect((await res.json()).forecast).toBeNull();
      expect(res.headers.get('cache-control')).toBe('public, max-age=900, s-maxage=900');
    });
  });

  test('upstream failure of everything: 503 watering_plan_unavailable, not cached', async () => {
    fetchServiceWeekWeather.mockRejectedValue(new Error('IEM down'));
    fetchUpcomingWeekForecast.mockResolvedValue(null);
    await withServer(async (base) => {
      const res = await get(base, '?location=bradenton-fl');
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'watering_plan_unavailable' });
      expect(res.headers.get('cache-control')).toBe('no-store');
    });
  });
});

describe('server/index.js wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const at = (needle) => { const i = src.indexOf(needle); expect(i).toBeGreaterThan(-1); return i; };

  // The `app.use(<paths>, <handler>);` statement that starts at `start`, run
  // against a fake app so the real handler code is what gets exercised.
  function mountedHandler(start) {
    const end = src.indexOf('\n});\n', start) + 4;
    const statement = src.slice(start, end);
    const mounts = [];
    const localRequire = (id) => require(id.startsWith('.') ? path.join(__dirname, '..', id) : id);
    new Function('app', 'require', statement)({ use: (paths, handler) => mounts.push({ paths, handler }) }, localRequire);
    expect(mounts).toHaveLength(1);
    return mounts[0];
  }
  function fakeRes() {
    const res = { headers: {}, statusCode: 200, body: undefined, ended: false };
    res.set = (k, v) => { res.headers[k] = v; return res; };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.end = () => { res.ended = true; return res; };
    return res;
  }

  test('the dark gate precedes the wildcard CORS handler, the credentialed cors(), the /api/ limiter and the router', () => {
    const gate = at("app.use('/api/public/watering-plan', (req, res, next) => {");
    expect(src.slice(gate, gate + 300)).toContain('publicWateringPlanLive()');
    const corsStar = at("app.use(['/api/public/pest-forecast', '/api/public/yard-calendar', '/api/public/watering-plan'], (req, res, next) => {");
    expect(gate).toBeLessThan(corsStar);
    expect(corsStar).toBeLessThan(at('app.use(cors({'));
    expect(gate).toBeLessThan(at("app.use('/api/', limiter);"));
    expect(gate).toBeLessThan(at("app.use('/api/public/watering-plan', require('./routes/public-watering-plan'));"));
  });

  test('dark: the index.js gate answers every method, including an OPTIONS preflight, with the generic 404', () => {
    const { handler } = mountedHandler(at("app.use('/api/public/watering-plan', (req, res, next) => {"));
    delete process.env.GATE_PUBLIC_WATERING_PLAN;
    for (const method of ['GET', 'OPTIONS', 'POST']) {
      const res = fakeRes();
      const next = jest.fn();
      handler({ method }, res, next);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
      expect(next).not.toHaveBeenCalled();
    }
    process.env.GATE_PUBLIC_WATERING_PLAN = 'true';
    const next = jest.fn();
    handler({ method: 'GET' }, fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('wildcard CORS: Access-Control-Allow-Origin * for the route, GET and OPTIONS only, no credentials, preflight answered 204', () => {
    const { paths, handler } = mountedHandler(at("app.use(['/api/public/pest-forecast', '/api/public/yard-calendar', '/api/public/watering-plan']"));
    expect(paths).toEqual(['/api/public/pest-forecast', '/api/public/yard-calendar', '/api/public/watering-plan']);

    const getRes = fakeRes();
    const next = jest.fn();
    handler({ method: 'GET' }, getRes, next);
    expect(getRes.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(getRes.headers['Access-Control-Allow-Methods']).toBe('GET, OPTIONS');
    expect(getRes.headers['Access-Control-Allow-Credentials']).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);

    const preflight = fakeRes();
    const preflightNext = jest.fn();
    handler({ method: 'OPTIONS' }, preflight, preflightNext);
    expect(preflight.statusCode).toBe(204);
    expect(preflight.ended).toBe(true);
    expect(preflight.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(preflightNext).not.toHaveBeenCalled();
  });
});
