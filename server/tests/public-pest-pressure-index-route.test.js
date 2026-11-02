// GET /api/public/pest-pressure-index (GATE_PUBLIC_PEST_PRESSURE_INDEX): the
// route's own behavior — dark gate before any limiter or query, the per-IP
// limit, JSON and CSV answers, cache headers, the 503 on a database failure —
// plus the server/index.js pieces the route tests cannot mount (gate order,
// wildcard CORS). Grouping and rounding are pinned in
// public-pest-pressure-index.test.js. All rows are synthetic.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'pest-pressure-index-test-secret';

jest.mock('../models/db', () => { const m = jest.fn(); m.raw = jest.fn(); m.fn = { now: () => 'now()' }; return m; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

jest.setTimeout(30000);

const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../models/db');
const logger = require('../services/logger');
const { _private: { _clearCache } } = require('../services/public-pest-pressure-index');

const PATH = '/api/public/pest-pressure-index';
const CONTRACT_KEYS = [
  'name', 'region', 'window', 'scale', 'min_visits', 'groups', 'hidden_groups', 'source', 'license', 'citation', 'page_url', 'generated_at',
];
const NOW = new Date('2026-11-02T15:00:00Z');
const ONLY_DATE = { doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] };

const saved = { gate: process.env.GATE_PUBLIC_PEST_PRESSURE_INDEX, nodeEnv: process.env.NODE_ENV };

let seq = 0;
function rows(count, overrides = {}) {
  return Array.from({ length: count }, () => {
    seq += 1;
    return {
      customer_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      first_name: `Test${seq}`,
      last_name: 'Customer',
      zip: '34205',
      service_line: 'pest',
      service_date: '2026-10-15',
      pressure_index: 2,
      is_tap: true,
      ...overrides,
    };
  });
}

function appServer() {
  const app = express();
  app.use(PATH, require('../routes/public-pest-pressure-index'));
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
  seq = 0;
  process.env.GATE_PUBLIC_PEST_PRESSURE_INDEX = 'true';
  process.env.NODE_ENV = 'test';
  db.raw.mockResolvedValue({ rows: [...rows(25), ...rows(21, { zip: '34236', service_line: 'lawn', pressure_index: 3 }), ...rows(4, { service_line: 'mosquito' })] });
  jest.useFakeTimers({ ...ONLY_DATE, now: NOW });
});
afterEach(() => jest.useRealTimers());
afterAll(() => {
  for (const [key, name] of [['gate', 'GATE_PUBLIC_PEST_PRESSURE_INDEX'], ['nodeEnv', 'NODE_ENV']]) {
    if (saved[key] === undefined) delete process.env[name];
    else process.env[name] = saved[key];
  }
});

describe('gate', () => {
  test('dark: the generic 404 for JSON, CSV and junk, no database query', async () => {
    delete process.env.GATE_PUBLIC_PEST_PRESSURE_INDEX;
    await withServer(async (base) => {
      for (const query of ['', '?format=csv', '?format=nope']) {
        const res = await get(base, query);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
      }
    });
    expect(db.raw).not.toHaveBeenCalled();
  });

  test('anything but exactly "true" is dark', async () => {
    await withServer(async (base) => {
      for (const value of ['1', 'TRUE', 'on', '']) {
        process.env.GATE_PUBLIC_PEST_PRESSURE_INDEX = value;
        expect((await get(base)).status).toBe(404);
      }
    });
    expect(db.raw).not.toHaveBeenCalled();
  });

  test('dark: the per-IP limiter never answers, even in production and past its budget', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.GATE_PUBLIC_PEST_PRESSURE_INDEX;
    await withServer(async (base) => {
      for (let i = 0; i < 125; i += 1) expect((await get(base)).status).toBe(404);
    });
  });
});

describe('per-IP limit', () => {
  test('production: 120 requests per 15 minutes, then 429; skipped outside production', async () => {
    process.env.NODE_ENV = 'production';
    await withServer(async (base) => {
      let last;
      for (let i = 0; i < 120; i += 1) {
        last = await get(base);
        expect(last.status).toBe(200);
      }
      expect(last.headers.get('ratelimit-limit')).toBe('120');
      const over = await get(base);
      expect(over.status).toBe(429);
      expect(await over.json()).toMatchObject({ error: 'rate_limited' });
    });
    expect(db.raw).toHaveBeenCalledTimes(1); // the 1-hour cache served the rest
  });
});

describe('GET /', () => {
  test('gate on: 200 JSON with the contract shape, published groups only, hidden groups counted', async () => {
    await withServer(async (base) => {
      const res = await get(base);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
      const body = await res.json();
      expect(Object.keys(body)).toEqual(CONTRACT_KEYS);
      expect(body.window).toEqual({ start: '2026-09-24', end: '2026-11-01', days: 39 });
      expect(body.scale.min).toBe(0);
      expect(body.scale.max).toBe(5);
      expect(Object.keys(body.scale.labels)).toEqual(['0', '1', '2', '3', '4', '5']);
      expect(body.min_visits).toBe(20);
      expect(body.groups).toEqual([
        { county: 'Manatee', service_line: 'pest', visits: 25, average: 2, median: 2 },
        { county: 'Sarasota', service_line: 'lawn', visits: 21, average: 3, median: 3 },
      ]);
      expect(body.hidden_groups).toBe(1);
      expect(body.license.name).toBe('CC BY 4.0');
      expect(body.generated_at).toBe(NOW.toISOString());
    });
  });

  test('?format=json is the same as the default', async () => {
    await withServer(async (base) => {
      const res = await get(base, '?format=json');
      expect(res.status).toBe(200);
      expect(Object.keys(await res.json())).toEqual(CONTRACT_KEYS);
    });
  });

  test('?format=csv: text/csv, the header and the published groups only', async () => {
    await withServer(async (base) => {
      const res = await get(base, '?format=csv');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
      expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
      expect(await res.text()).toBe([
        'county,service_line,visits,average,median,window_start,window_end',
        'Manatee,pest,25,2.0,2.0,2026-09-24,2026-11-01',
        'Sarasota,lawn,21,3.0,3.0,2026-09-24,2026-11-01',
        '',
      ].join('\n'));
    });
  });

  test('an unknown or repeated format is a 400 with a short JSON error, not cached', async () => {
    await withServer(async (base) => {
      for (const query of ['?format=xml', '?format=csv&format=json']) {
        const res = await get(base, query);
        expect([query, res.status]).toEqual([query, 400]);
        expect((await res.json()).error).toBe('invalid_format');
        expect(res.headers.get('cache-control')).toBe('no-store');
      }
    });
    expect(db.raw).not.toHaveBeenCalled();
  });

  test('the result is cached in memory: JSON and CSV share one query', async () => {
    await withServer(async (base) => {
      await get(base);
      await get(base, '?format=csv');
      await get(base);
    });
    expect(db.raw).toHaveBeenCalledTimes(1);
  });

  test('database failure: a bare 503 JSON error with no stack or SQL, not cached; the next request retries', async () => {
    db.raw.mockRejectedValue(new Error('relation "service_records" does not exist; at Object.query (/app/server/x.js:1:1)'));
    await withServer(async (base) => {
      for (const query of ['', '?format=csv']) {
        const res = await get(base, query);
        expect(res.status).toBe(503);
        expect(res.headers.get('content-type')).toMatch(/application\/json/);
        expect(res.headers.get('cache-control')).toBe('no-store');
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ error: 'pest_pressure_index_unavailable' });
        expect(text).not.toMatch(/service_records|relation|at Object|\.js/);
      }
      expect(db.raw).toHaveBeenCalledTimes(2); // the failure was not cached
      db.raw.mockResolvedValue({ rows: rows(25) });
      expect((await get(base)).status).toBe(200);
    });
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});

describe('server/index.js wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const at = (needle) => { const i = src.indexOf(needle); expect(i).toBeGreaterThan(-1); return i; };

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
    const gate = at("app.use('/api/public/pest-pressure-index', (req, res, next) => {");
    expect(src.slice(gate, gate + 300)).toContain('publicPestPressureIndexLive()');
    const corsStar = at("app.use(['/api/public/pest-forecast', '/api/public/yard-calendar', '/api/public/watering-plan', '/api/public/pest-pressure-index'], (req, res, next) => {");
    expect(gate).toBeLessThan(corsStar);
    expect(corsStar).toBeLessThan(at('app.use(cors({'));
    expect(gate).toBeLessThan(at("app.use('/api/', limiter);"));
    expect(gate).toBeLessThan(at("app.use('/api/public/pest-pressure-index', require('./routes/public-pest-pressure-index'));"));
  });

  test('dark: the index.js gate answers every method, including an OPTIONS preflight, with the generic 404', () => {
    const { handler } = mountedHandler(at("app.use('/api/public/pest-pressure-index', (req, res, next) => {"));
    delete process.env.GATE_PUBLIC_PEST_PRESSURE_INDEX;
    for (const method of ['GET', 'OPTIONS', 'POST']) {
      const res = fakeRes();
      const next = jest.fn();
      handler({ method }, res, next);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
      expect(next).not.toHaveBeenCalled();
    }
    process.env.GATE_PUBLIC_PEST_PRESSURE_INDEX = 'true';
    const next = jest.fn();
    handler({ method: 'GET' }, fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('wildcard CORS: Access-Control-Allow-Origin * on the path, GET and OPTIONS only, no credentials, preflight answered 204', () => {
    const { paths, handler } = mountedHandler(at("app.use(['/api/public/pest-forecast', '/api/public/yard-calendar', '/api/public/watering-plan', '/api/public/pest-pressure-index']"));
    expect(paths).toContain('/api/public/pest-pressure-index');

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
    expect(preflight.headers['Access-Control-Allow-Origin']).toBe('*');
    expect(preflightNext).not.toHaveBeenCalled();
  });

  test('a live response carries Access-Control-Allow-Origin * when the app-level handler runs ahead of the router', async () => {
    const { handler } = mountedHandler(at("app.use(['/api/public/pest-forecast', '/api/public/yard-calendar', '/api/public/watering-plan', '/api/public/pest-pressure-index']"));
    const app = express();
    app.use(PATH, handler, require('../routes/public-pest-pressure-index'));
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${PATH}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
