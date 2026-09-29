process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.GOOGLE_MAPS_API_KEY = 'test-maps-key';
delete process.env.PROPERTY_LOOKUP_PARCEL_OVERLAY;
delete process.env.GOOGLE_API_KEY;

// B12: the server Google Maps key must never reach a customer response.
//   - stored satellite_url (even one that already holds key=...) is served
//     as a token-scoped proxy path, in /data (normal + pdf pass) and SSR HTML
//   - GET /:token/map/satellite|overlay rebuilds the Static Maps URL from the
//     estimate's own stored params (caller query ignored), appends the key
//     server-side, and streams the bytes; bad/unviewable tokens 404
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn(() => false),
  gateEnvValue: jest.fn(() => false),
  gates: {},
}));
jest.mock('../services/property-lookup/lookup-cache', () => ({
  getCachedLookup: jest.fn(),
}));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn().mockResolvedValue(null),
  // Identity stub: this suite's membership is always null, and the real
  // projection maps null → null; the whitelist itself is covered by
  // estimate-public-existing-customer.test.js.
  publicMembershipView: jest.fn((snapshot) => snapshot ?? null),
}));
jest.mock('../services/estimate-deposits', () => ({
  ensureDepositSatisfied: jest.fn(),
  resolveDepositPolicyForEstimate: jest.fn().mockResolvedValue({
    enforced: false,
    required: false,
    slotRequired: false,
  }),
  computeDepositAmount: jest.fn(() => 0),
  pendingDepositCredit: jest.fn(),
  consumeDepositCredit: jest.fn(),
  refundUnconsumedDeposits: jest.fn(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { getCachedLookup } = require('../services/property-lookup/lookup-cache');
const { renderPage } = require('../routes/estimate-public');
const estimatePublicRouter = require('../routes/estimate-public');

// ── db chain mock ────────────────────────────────────────────────
let dbRows = {};

function chainFor(result) {
  const chain = {
    where: jest.fn(() => chain),
    whereIn: jest.fn(() => chain),
    whereNull: jest.fn(() => chain),
    whereRaw: jest.fn(() => chain),
    andWhere: jest.fn(() => chain),
    orWhere: jest.fn(() => chain),
    orWhereRaw: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    select: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    first: jest.fn().mockResolvedValue(result),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue([1]),
  };
  return chain;
}

db.mockImplementation((table) => chainFor(dbRows[table]));

// ── fixtures ─────────────────────────────────────────────────────
const PARCEL_ID = '7654321098';

function enrichedFixture(overrides = {}) {
  return {
    homeSqFt: 2150,
    lotSqFt: 9800,
    stories: 2,
    yearBuilt: 1998,
    pool: 'YES',
    poolSource: 'county',
    poolCageSqft: 640,
    hasSpa: false,
    estimatedTurfSf: 6800,
    turfCappedToParcel: true,
    parcel: { parcelId: PARCEL_ID, county: 'Manatee', areaSqft: 10019, source: 'fdor_cadastral' },
    propertyDataQuality: { level: 'low', score: 42, fieldVerifyCount: 3 },
    fieldEvidence: {
      squareFootage: { sourceType: 'county' },
      lotSize: { sourceType: 'cadastral' },
      stories: { sourceType: 'verified' },
      yearBuilt: { sourceType: 'permit' },
      hasPool: { sourceType: 'county' },
    },
    ...overrides,
  };
}

function renderEstimate(overrides = {}) {
  return {
    id: 'estimate-syw',
    status: 'sent',
    customerName: 'Pat Tester',
    address: '123 Trust Ln, Bradenton, FL 34203',
    monthlyTotal: 0,
    annualTotal: 0,
    onetimeTotal: 0,
    tier: 'Bronze',
    satelliteUrl: 'https://maps.googleapis.com/maps/api/staticmap?center=stored-image',
    ...overrides,
  };
}

function renderEstimateData(extra = {}) {
  return {
    result: {
      recurring: { discount: 0, services: [{ name: 'Pest Control', mo: 88 }] },
      oneTime: { items: [], membershipFee: 99 },
    },
    ...extra,
  };
}

function estimateRow(overrides = {}) {
  return {
    id: 'est-syw-1',
    token: 'showyourworktoken',
    status: 'sent',
    sent_at: null, // shouldCountView short-circuits — no view-tracking writes
    viewed_at: null,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    customer_name: 'Pat Tester',
    customer_phone: null,
    customer_email: null,
    address: '123 Trust Ln, Bradenton, FL 34203',
    satellite_url: 'https://maps.googleapis.com/maps/api/staticmap?center=stored-image',
    waveguard_tier: 'Bronze',
    show_one_time_option: false,
    bill_by_invoice: false,
    estimate_data: {
      sendSnapshot: {
        pricingBundle: {
          frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 88, annual: 1056 }],
          waveGuardTier: 'Bronze',
          anchorOneTimePrice: 0,
          source: 'send_snapshot_fixture',
        },
      },
      result: {
        recurring: { discount: 0, services: [{ name: 'Pest Control', mo: 88 }] },
        oneTime: { items: [], membershipFee: 99 },
      },
      enriched: enrichedFixture(),
    },
    ...overrides,
  };
}

// Closed square ring in [lng, lat] order, the GIS shape buildParcelOverlayParam expects.
function polygonFixture() {
  return [[
    [-82.5001, 27.3001],
    [-82.5001, 27.2999],
    [-82.4999, 27.2999],
    [-82.4999, 27.3001],
    [-82.5001, 27.3001],
  ]];
}

function cacheRowFixture(overrides = {}) {
  return {
    parcel: { parcelId: PARCEL_ID, county: 'Manatee', polygon: polygonFixture(), polygonAreaSqft: 10019 },
    lat: 27.3,
    lng: -82.5,
    ...overrides,
  };
}

// ── route harness (reports-public test idiom) ────────────────────
function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/estimates', estimatePublicRouter);
   
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    server.close();
  }
}

beforeEach(() => {
  dbRows = {};
  isEnabled.mockReset();
  isEnabled.mockReturnValue(false);
  getCachedLookup.mockReset();
  getCachedLookup.mockResolvedValue(null);
});


const mapImage = require('../services/estimate-map-image');

const STORED_KEYED = 'https://maps.googleapis.com/maps/api/staticmap?center=27.3,-82.5&zoom=19&size=640x640&maptype=satellite&format=png&key=STORED-LEAKED-KEY';
const TOKEN = 'showyourworktoken';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

let realFetch;
let upstreamCalls;
let upstreamResponder;

beforeAll(() => { realFetch = global.fetch; });
afterAll(() => { global.fetch = realFetch; });

beforeEach(() => {
  dbRows = {};
  isEnabled.mockReset();
  isEnabled.mockReturnValue(false);
  getCachedLookup.mockReset();
  getCachedLookup.mockResolvedValue(null);
  mapImage.clearImageCache();
  upstreamCalls = [];
  upstreamResponder = () => ({
    ok: true,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => PNG,
  });
  global.fetch = jest.fn((url, init) => {
    if (String(url).startsWith('https://maps.googleapis.com/')) {
      upstreamCalls.push(String(url));
      return Promise.resolve(upstreamResponder(String(url)));
    }
    return realFetch(url, init);
  });
});

describe('GET /:token/map/satellite', () => {
  test('streams the image for a valid token, key added server-side from stored params only', async () => {
    dbRows = { estimates: estimateRow({ satellite_url: STORED_KEYED }) };
    await withServer(async (baseUrl) => {
      // Caller-supplied params (center, zoom, key, markers, url) must be ignored.
      const res = await fetch(`${baseUrl}/estimates/${TOKEN}/map/satellite?center=99,99&zoom=1&key=caller-key&markers=evil&url=http://169.254.169.254/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toMatch(/private/);
      expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    });
    expect(upstreamCalls).toHaveLength(1);
    const upstream = new URL(upstreamCalls[0]);
    expect(upstream.origin + upstream.pathname).toBe('https://maps.googleapis.com/maps/api/staticmap');
    expect(upstream.searchParams.get('center')).toBe('27.3,-82.5');
    expect(upstream.searchParams.get('zoom')).toBe('19');
    expect(upstream.searchParams.get('size')).toBe('640x640');
    // Exactly one key: the server's. Not the stored one, not the caller's.
    expect(upstream.searchParams.getAll('key')).toEqual(['test-maps-key']);
    expect(upstreamCalls[0]).not.toMatch(/STORED-LEAKED-KEY|caller-key|evil|99,99|169\.254/);
  });

  test('repeat requests for the same estimate hit the in-memory cache, not Google', async () => {
    dbRows = { estimates: estimateRow({ satellite_url: STORED_KEYED }) };
    await withServer(async (baseUrl) => {
      for (let i = 0; i < 3; i += 1) {
        const res = await fetch(`${baseUrl}/estimates/${TOKEN}/map/satellite`);
        expect(res.status).toBe(200);
        await res.arrayBuffer();
      }
    });
    expect(upstreamCalls).toHaveLength(1);
  });

  test('unknown token -> 404 and no upstream fetch', async () => {
    dbRows = { estimates: undefined };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/nosuchtoken/map/satellite`);
      expect(res.status).toBe(404);
    });
    expect(upstreamCalls).toHaveLength(0);
  });

  test('expired / archived estimate -> 404 and no upstream fetch', async () => {
    for (const overrides of [{ status: 'expired' }, { archived_at: new Date().toISOString() }, { status: 'draft' }]) {
      dbRows = { estimates: estimateRow({ satellite_url: STORED_KEYED, ...overrides }) };
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/estimates/${TOKEN}/map/satellite`);
        expect(res.status).toBe(404);
      });
    }
    expect(upstreamCalls).toHaveLength(0);
  });

  test('stored URL that is not a usable Google Static Maps URL -> 404, never fetched', async () => {
    for (const bad of [
      'https://example.com/tile.png',
      'https://maps.googleapis.com/maps/api/geocode/json?address=x',
      'http://169.254.169.254/latest/meta-data',
      'https://maps.googleapis.com/maps/api/staticmap?center=27.3,-82.5&zoom=99',
      'https://maps.googleapis.com/maps/api/staticmap?center=27.3,-82.5&size=5000x5000',
      null,
    ]) {
      mapImage.clearImageCache();
      dbRows = { estimates: estimateRow({ satellite_url: bad }) };
      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/estimates/${TOKEN}/map/satellite`);
        expect(res.status).toBe(404);
      });
    }
    expect(upstreamCalls).toHaveLength(0);
  });

  test('upstream failure -> generic 404 with no key or URL in the body', async () => {
    upstreamResponder = () => ({ ok: false, status: 403, headers: { get: () => 'text/html' }, arrayBuffer: async () => Buffer.from('nope') });
    dbRows = { estimates: estimateRow({ satellite_url: STORED_KEYED }) };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${TOKEN}/map/satellite`);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'Estimate not found' });
      expect(text).not.toMatch(/key|maps\.googleapis|test-maps-key/i);
    });
  });

  test('non-image upstream content-type is refused', async () => {
    upstreamResponder = () => ({ ok: true, headers: { get: () => 'text/html' }, arrayBuffer: async () => Buffer.from('<html>') });
    dbRows = { estimates: estimateRow({ satellite_url: STORED_KEYED }) };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${TOKEN}/map/satellite`);
      expect(res.status).toBe(404);
    });
  });
});

describe('map proxy rate limit', () => {
  test('30/min per client; IPv6 addresses in one /64 share a bucket', async () => {
    dbRows = { estimates: estimateRow({ satellite_url: STORED_KEYED }) };
    const app = express();
    app.set('trust proxy', true);
    app.use('/estimates', estimatePublicRouter);
    const server = app.listen(0);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const hit = (ip) => fetch(`${baseUrl}/estimates/${TOKEN}/map/satellite`, { headers: { 'X-Forwarded-For': ip } });
    try {
      for (let i = 0; i < 30; i += 1) {
        const res = await hit(`2001:db8:1:2::${i + 1}`);
        expect(res.status).toBe(200);
        await res.arrayBuffer();
      }
      // Different address, same /64 -> same bucket -> limited.
      const limited = await hit('2001:db8:1:2:ffff::9');
      expect(limited.status).toBe(429);
      // A different /64 is unaffected.
      const other = await hit('2001:db8:9:9::1');
      expect(other.status).toBe(200);
      await other.arrayBuffer();
    } finally {
      server.close();
    }
  });
});

describe('map proxy pre-guard (mounted before the global /api limiter)', () => {
  const rateLimit = require('express-rate-limit');

  async function withGuardedApp(globalMax, fn) {
    const app = express();
    app.use('/api/estimates', estimatePublicRouter.mapImagePreGuard);
    app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: globalMax, standardHeaders: true, legacyHeaders: false }));
    app.use('/api/estimates', estimatePublicRouter);
    const server = app.listen(0);
    try {
      return await fn(`http://127.0.0.1:${server.address().port}/api/estimates`);
    } finally {
      server.close();
    }
  }

  const expectPrivacyHeaders = (res) => {
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  };

  test('server/index.js mounts the guard before the global /api/ limiter', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
    const guardAt = src.indexOf("app.use('/api/estimates', estimatePublicRoutes.mapImagePreGuard)");
    const limiterAt = src.indexOf("app.use('/api/', limiter)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(limiterAt).toBeGreaterThan(guardAt);
  });

  test('dark overlay: an over-budget IP still gets the generic 404, never 429', async () => {
    getCachedLookup.mockResolvedValue(cacheRowFixture());
    dbRows = { estimates: estimateRow() };
    await withGuardedApp(2, async (base) => {
      for (let i = 0; i < 6; i += 1) {
        const res = await fetch(`${base}/${TOKEN}/map/overlay`);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Estimate not found' });
        expectPrivacyHeaders(res);
      }
    });
    expect(upstreamCalls).toHaveLength(0);
  });

  test('malformed token 404 carries no-store + CORP', async () => {
    await withGuardedApp(100, async (base) => {
      for (const kind of ['satellite', 'overlay']) {
        const res = await fetch(`${base}/short/map/${kind}`);
        expect(res.status).toBe(404);
        expectPrivacyHeaders(res);
      }
    });
  });

  test('a 429 (global limiter) carries no-store + CORP on both map routes', async () => {
    isEnabled.mockImplementation((name) => name === 'estimateShowYourWork');
    getCachedLookup.mockResolvedValue(cacheRowFixture());
    dbRows = { estimates: estimateRow({ satellite_url: STORED_KEYED }) };
    await withGuardedApp(1, async (base) => {
      const first = await fetch(`${base}/${TOKEN}/map/satellite`);
      expect(first.status).toBe(200);
      await first.arrayBuffer();
      for (const kind of ['satellite', 'overlay']) {
        const limited = await fetch(`${base}/${TOKEN}/map/${kind}`);
        expect(limited.status).toBe(429);
        expectPrivacyHeaders(limited);
      }
    });
  });

  test('HEAD, uppercase path and trailing slash all take the same guarded path (dark overlay, over budget)', async () => {
    getCachedLookup.mockResolvedValue(cacheRowFixture());
    dbRows = { estimates: estimateRow() };
    const variants = [
      ['HEAD', `/${TOKEN}/map/overlay`],
      ['GET', `/${TOKEN}/MAP/OVERLAY`],
      ['GET', `/${TOKEN}/Map/Overlay/`],
      ['GET', `/${TOKEN}/map/overlay/`],
      ['HEAD', `/${TOKEN}/MAP/overlay/`],
    ];
    await withGuardedApp(1, async (base) => {
      for (let i = 0; i < 3; i += 1) {
        for (const [method, path] of variants) {
          const res = await fetch(`${base}${path}`, { method });
          expect(res.status).toBe(404);
          expectPrivacyHeaders(res);
          await res.arrayBuffer();
        }
      }
    });
    expect(upstreamCalls).toHaveLength(0);
  });

  test('HEAD and uppercase satellite 429s carry the headers', async () => {
    dbRows = { estimates: estimateRow({ satellite_url: STORED_KEYED }) };
    await withGuardedApp(1, async (base) => {
      const first = await fetch(`${base}/${TOKEN}/map/satellite`);
      expect(first.status).toBe(200);
      await first.arrayBuffer();
      for (const [method, path] of [['HEAD', `/${TOKEN}/map/satellite`], ['GET', `/${TOKEN}/MAP/SATELLITE/`]]) {
        const res = await fetch(`${base}${path}`, { method });
        expect(res.status).toBe(429);
        expectPrivacyHeaders(res);
        await res.arrayBuffer();
      }
    });
  });

  test('non-map routes and methods are untouched by the guard', async () => {
    dbRows = { estimates: estimateRow() };
    await withGuardedApp(100, async (base) => {
      for (const [method, path] of [
        ['GET', `/${TOKEN}/data`],
        ['HEAD', `/${TOKEN}/data`],
        ['GET', `/${TOKEN}/map`],
        ['GET', `/${TOKEN}/map/other`],
        ['POST', `/${TOKEN}/map/overlay`],
      ]) {
        const res = await fetch(`${base}${path}`, { method });
        expect(res.headers.get('cross-origin-resource-policy')).toBeNull();
        await res.arrayBuffer();
      }
    });
  });

  test('a successful image overwrites Cache-Control with the private max-age', async () => {
    dbRows = { estimates: estimateRow({ satellite_url: STORED_KEYED }) };
    await withGuardedApp(100, async (base) => {
      const res = await fetch(`${base}/${TOKEN}/map/satellite`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
      expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
      await res.arrayBuffer();
    });
  });

  test('other estimate routes are untouched by the guard', async () => {
    dbRows = { estimates: estimateRow() };
    await withGuardedApp(100, async (base) => {
      const res = await fetch(`${base}/${TOKEN}/data`);
      expect(res.headers.get('cross-origin-resource-policy')).toBeNull();
      await res.arrayBuffer();
    });
  });
});

describe('GET /:token/map/overlay', () => {
  test('gate on + cached polygon: streams the overlay, URL rebuilt from the cached row', async () => {
    isEnabled.mockImplementation((name) => name === 'estimateShowYourWork');
    getCachedLookup.mockResolvedValue(cacheRowFixture());
    dbRows = { estimates: estimateRow() };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${TOKEN}/map/overlay?path=evil`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      await res.arrayBuffer();
    });
    expect(upstreamCalls).toHaveLength(1);
    const upstream = new URL(upstreamCalls[0]);
    expect(upstream.searchParams.get('center')).toBe('27.3,-82.5');
    expect(upstream.searchParams.get('zoom')).toBe('20');
    expect(upstream.searchParams.get('path')).toMatch(/^color:0xff0000ff\|weight:3\|/);
    expect(upstream.searchParams.getAll('key')).toEqual(['test-maps-key']);
    expect(upstreamCalls[0]).not.toContain('evil');
  });

  test('gate off -> 404', async () => {
    getCachedLookup.mockResolvedValue(cacheRowFixture());
    dbRows = { estimates: estimateRow() };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${TOKEN}/map/overlay`);
      expect(res.status).toBe(404);
    });
    expect(upstreamCalls).toHaveLength(0);
  });

  test('gate off: repeated requests stay a generic 404, never 429 (dark route skips its limiter)', async () => {
    getCachedLookup.mockResolvedValue(cacheRowFixture());
    dbRows = { estimates: estimateRow() };
    await withServer(async (baseUrl) => {
      for (let i = 0; i < 45; i += 1) {
        const res = await fetch(`${baseUrl}/estimates/${TOKEN}/map/overlay`);
        expect(res.status).toBe(404);
        await res.arrayBuffer();
      }
    });
    expect(upstreamCalls).toHaveLength(0);
  });

  test('no cached polygon -> 404', async () => {
    isEnabled.mockImplementation((name) => name === 'estimateShowYourWork');
    dbRows = { estimates: estimateRow() };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${TOKEN}/map/overlay`);
      expect(res.status).toBe(404);
    });
  });
});

describe('public payloads never carry the server Maps key', () => {
  function assertNoKey(text) {
    expect(text).not.toContain('STORED-LEAKED-KEY');
    expect(text).not.toContain('test-maps-key');
    expect(text).not.toMatch(/maps\.googleapis\.com[^"']*key=/);
  }

  test('GET /:token/data: keyed stored satellite_url is replaced by the proxy path', async () => {
    dbRows = { estimates: estimateRow({ satellite_url: STORED_KEYED }) };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${TOKEN}/data`);
      expect(res.status).toBe(200);
      const text = await res.text();
      assertNoKey(text);
      const body = JSON.parse(text);
      expect(body.estimate.satelliteUrl).toBe(`/api/estimates/${TOKEN}/map/satellite`);
      expect(body.estimate.intelligence.satelliteUrl).toBe(`/api/estimates/${TOKEN}/map/satellite`);
    });
  });

  test('GET /:token/data?mode=pdf (render pass): proxy path for a Google URL, null otherwise', async () => {
    dbRows = { estimates: estimateRow({ satellite_url: STORED_KEYED }) };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${TOKEN}/data?mode=pdf`);
      expect(res.status).toBe(200);
      const text = await res.text();
      assertNoKey(text);
      expect(JSON.parse(text).estimate.satelliteUrl).toBe(`/api/estimates/${TOKEN}/map/satellite`);
    });
    dbRows = { estimates: estimateRow({ satellite_url: 'https://internal.example/x.png' }) };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${TOKEN}/data?mode=pdf`);
      expect(JSON.parse(await res.text()).estimate.satelliteUrl).toBeNull();
    });
  });

  test('a keyed URL hiding in estimate_data is scrubbed from /data', async () => {
    const row = estimateRow({ satellite_url: null });
    row.estimate_data.satelliteUrl = STORED_KEYED;
    row.estimate_data.somethingElse = { img: `${STORED_KEYED}&extra=1`, raw: 'test-maps-key' };
    dbRows = { estimates: row };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${TOKEN}/data`);
      const text = await res.text();
      assertNoKey(text);
      expect(JSON.parse(text).estimate.intelligence.satelliteUrl).toBe(`/api/estimates/${TOKEN}/map/satellite`);
    });
  });

  test('GET /:token/data with show-your-work on: overlay is a proxy path, no key anywhere', async () => {
    isEnabled.mockImplementation((name) => name === 'estimateShowYourWork');
    getCachedLookup.mockResolvedValue(cacheRowFixture());
    dbRows = { estimates: estimateRow({ satellite_url: STORED_KEYED }) };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${TOKEN}/data`);
      const text = await res.text();
      assertNoKey(text);
      expect(JSON.parse(text).showYourWork.overlaySatelliteUrl).toBe(`/api/estimates/${TOKEN}/map/overlay`);
    });
  });

  test('SSR renderPage: keyed stored URL renders as the proxy path', () => {
    const html = renderPage('syw-token', renderEstimate({ satelliteUrl: STORED_KEYED }), renderEstimateData(), null);
    assertNoKey(html);
    expect(html).toContain('src="/api/estimates/syw-token/map/satellite"');
  });
});

describe('scrub covers escaped and differently-keyed URLs', () => {
  const OTHER = 'AIzaSyOTHERKEY0123456789abcdefghijklmn';
  const BASE = 'https://maps.googleapis.com/maps/api/staticmap?center=1,2&zoom=3';

  test('entity, JSON and query-first forms all lose the key', () => {
    const forms = [
      `${BASE}&key=${OTHER}`,
      `${BASE}&amp;key=${OTHER}`,
      `${BASE}&#38;key=${OTHER}`,
      `${BASE}&#x26;key=${OTHER}&amp;size=640x640`,
      `${BASE}\\u0026key=${OTHER}`,
      `https://maps.googleapis.com/maps/api/staticmap?key=${OTHER}&amp;center=1,2`,
      `https://maps.googleapis.com/maps/api/staticmap?key=${OTHER}`,
      `see this: key=${OTHER} in prose`,
      `bare ${OTHER} shape`,
    ];
    for (const f of forms) {
      const out = mapImage.scrubMapsKeysFromString(f);
      expect(out).not.toContain(OTHER);
      expect(out).not.toMatch(/key=/i);
    }
    expect(mapImage.scrubMapsKeysFromString(`${BASE}&amp;key=${OTHER}&amp;size=640x640`)).toContain('&amp;size=640x640');
  });

  test('sendEstimatePage: an authored field with a differently-keyed, HTML-escaped URL never reaches the HTML', () => {
    const authored = `https://maps.googleapis.com/maps/api/staticmap?center=27.3,-82.5&zoom=19&key=${OTHER}`;
    const html = [];
    const res = {
      set() { return res; },
      send(body) { html.push(body); return res; },
    };
    estimatePublicRouter.sendEstimatePage(
      res,
      'syw-token',
      renderEstimate({ address: `1 Test St ${authored}`, customerName: `Pat ${authored}` }),
      renderEstimateData({ note: authored }),
      null,
    );
    expect(html).toHaveLength(1);
    expect(html[0]).toContain('1 Test St');
    expect(html[0]).not.toContain(OTHER);
    expect(html[0]).not.toContain('test-maps-key');
    expect(html[0]).not.toMatch(/maps\.googleapis\.com[^"'<\s]*key=/i);
    expect(html[0]).not.toMatch(/amp;key=/i);
  });

  test('scrubMapsKeysDeep leaves Dates and class instances alone', () => {
    const when = new Date('2026-01-01T00:00:00Z');
    const map = new Map([['a', 1]]);
    const out = mapImage.scrubMapsKeysDeep({ when, map, n: [1, { s: 'x' }] });
    expect(out.when).toBe(when);
    expect(out.map).toBe(map);
    expect(out.n[1].s).toBe('x');
  });
});

describe('estimate-map-image helpers', () => {
  test('publicSatelliteUrl', () => {
    const { publicSatelliteUrl } = mapImage;
    expect(publicSatelliteUrl(STORED_KEYED, 'tok')).toBe('/api/estimates/tok/map/satellite');
    expect(publicSatelliteUrl(STORED_KEYED, null)).toBeNull();
    expect(publicSatelliteUrl('https://maps.googleapis.com/maps/api/place/photo?key=abc', 'tok')).toBeNull();
    expect(publicSatelliteUrl('/api/estimates/tok/map/overlay', 'tok')).toBe('/api/estimates/tok/map/overlay');
    expect(publicSatelliteUrl('', 'tok')).toBeNull();
    expect(publicSatelliteUrl('https://cdn.example/x.png', 'tok')).toBe('https://cdn.example/x.png');
  });

  test('sanitizedStaticMapUrlFromStored keeps only allow-listed, range-checked params', () => {
    const out = mapImage.sanitizedStaticMapUrlFromStored(
      'https://maps.googleapis.com/maps/api/staticmap?center=27.3,-82.5&zoom=19&size=640x640&maptype=satellite&format=png&key=K&markers=evil&signature=s&path=x',
    );
    expect(out).not.toMatch(/key=|markers|signature|path=/);
    expect(out).toContain('zoom=19');
    expect(mapImage.sanitizedStaticMapUrlFromStored('https://maps.googleapis.com/maps/api/staticmap?zoom=19')).toBeNull();
    expect(mapImage.sanitizedStaticMapUrlFromStored('https://maps.googleapis.com/maps/api/staticmap?center=1,2&maptype=roadmap')).toBeNull();
  });

  test('scrubMapsKeysDeep strips keys from nested strings and blanks the literal server key', () => {
    const out = mapImage.scrubMapsKeysDeep({
      a: [`https://maps.googleapis.com/maps/api/staticmap?center=1,2&key=SECRET123&zoom=3`],
      b: { c: 'prefix test-maps-key suffix' },
      d: 5,
      e: null,
    });
    expect(JSON.stringify(out)).not.toMatch(/SECRET123|test-maps-key/);
    expect(out.a[0]).toContain('zoom=3');
    expect(out.d).toBe(5);
    expect(out.e).toBeNull();
  });
});
