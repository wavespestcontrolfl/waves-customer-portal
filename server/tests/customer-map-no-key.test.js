process.env.JWT_SECRET = 'test-secret-for-customer-map-no-key';
process.env.GOOGLE_MAPS_API_KEY = 'test-maps-key-CCCC3333';
process.env.GATE_PORTAL_STATION_MAP = 'true';
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_STATIC_MAPS_API_KEY;
delete process.env.REPORT_PIN_SECRET;
delete process.env.SERVICE_REPORT_BASEMAP_PROVIDER;

// Regression guard: no customer-facing map payload we touched may carry the
// server Google Maps key (the key Geocoding/Routes also use, which cannot be
// referrer-restricted). Covers the public service-report treatment map, the
// report station map derived from it, and the authenticated portal
// station-map route, plus a static scan that keeps keyed Static Maps URLs out
// of every module except an explicit server-only / staff-only allowlist.
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.customerId = 'cust-1'; next(); },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: jest.fn(async () => {}) }));

const fs = require('fs');
const path = require('path');

const tables = {};
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const rows = () => Promise.resolve(tables[table] || []);
    const q = {};
    for (const m of ['where', 'whereIn', 'orderBy', 'select', 'join']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => (tables[table] || [])[0] || null);
    q.then = (ok, bad) => rows().then(ok, bad);
    q.catch = (fn) => rows().catch(fn);
    return q;
  });
  db.raw = jest.fn((sql) => sql);
  return db;
});

const signed = require('../services/signed-map-image');
const { scrubMapsKeysFromString } = require('../services/estimate-map-image');
const { buildSatelliteTreatmentMapContext } = require('../services/service-report/satellite-treatment-map');
const { buildStationMapReportContext } = require('../services/termite-stations');
const propertyRouter = require('../routes/property');

const KEY_PATTERNS = /AIza|key=|maps\.googleapis\.com|test-maps-key|CCCC3333/i;
function expectNoKey(payload) {
  const text = JSON.stringify(payload);
  expect(text).not.toMatch(KEY_PATTERNS);
  expect(scrubMapsKeysFromString(text)).toBe(text);
}

const REF = { lat: 27.36, lng: -82.38, zoom: 20, width: 640, height: 340 };
const pin = (cx, cy) => ({ type: 'circle', cx, cy, r: 0.035, ref: REF });

describe('service report satellite treatment map', () => {
  const service = { customer_latitude: 27.36, customer_longitude: -82.38 };

  test('live.url is a signed proxy path; the payload carries no Google URL or key', async () => {
    const ctx = await buildSatelliteTreatmentMapContext({ service, zones: [], applications: [], flags: [], mode: 'live' });
    expect(ctx.available).toBe(true);
    expect(ctx.live.url).toMatch(/^\/api\/public\/map-image\/v1\.[\w-]+\.[\w-]{43}$/);
    expect(signed.verifyMapImageToken(ctx.live.url.split('/').pop())).toEqual({
      lat: '27.3600000', lng: '-82.3800000', zoom: 20, width: 640, height: 340, scale: 2, maptype: 'satellite',
    });
    expectNoKey(ctx);
  });

  test('the report station map built from it carries the same signed path, no key', async () => {
    const ctx = await buildSatelliteTreatmentMapContext({ service, zones: [], applications: [], flags: [], mode: 'live' });
    const stationMap = buildStationMapReportContext({
      stationRows: [{ id: 'st-1', station_number: 1, geometry_image: pin(0.4, 0.5), label: null, program: 'termite' }],
      checkRows: [{ station_id: 'st-1', status: 'ok' }],
      satelliteMap: ctx,
      imageContext: { center: { lat: REF.lat, lng: REF.lng }, zoom: 20, width: 640, height: 340 },
      typedTypes: ['termite_bait_station'],
      serviceDate: '2026-07-13',
    });
    expect(stationMap.available).toBe(true);
    expect(stationMap.image.url).toBe(ctx.live.url);
    expectNoKey(stationMap);
  });

  test('cannot sign (no server secret) -> no map, never a keyed fallback', async () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      const ctx = await buildSatelliteTreatmentMapContext({ service, zones: [], applications: [], flags: [], mode: 'live' });
      expect(ctx).toEqual({ available: false, fallbackReason: 'provider_config_unavailable' });
    } finally {
      process.env.JWT_SECRET = saved;
    }
  });

  test('sms_preview and static exports never carry a map at all', async () => {
    expect((await buildSatelliteTreatmentMapContext({ service, mode: 'sms_preview' })).available).toBe(false);
    expect((await buildSatelliteTreatmentMapContext({ service, mode: 'pdf' })).available).toBe(false);
  });
});

describe('GET /api/property/station-map (customer portal)', () => {
  async function invoke() {
    const layer = propertyRouter.stack.find((l) => l.route?.path === '/station-map' && l.route.methods.get);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    let body = null;
    let error = null;
    await handler({ customerId: 'cust-1', query: {}, params: {} }, { json(p) { body = p; return this; }, status() { return this; } }, (e) => { error = e; });
    if (error) throw error;
    return body;
  }

  beforeEach(() => {
    tables.termite_stations = [
      { id: 'st-1', station_number: 1, geometry_image: pin(0.2, 0.3), label: null, program: 'termite', is_active: true },
      { id: 'st-2', station_number: 2, geometry_image: pin(0.6, 0.5), label: null, program: 'termite', is_active: true },
    ];
    tables.customers = [{ latitude: '27.36', longitude: '-82.38' }];
    tables.property_geometries = [];
    tables.termite_station_checks = [];
  });

  test('the station map image is a signed proxy path with no key', async () => {
    const body = await invoke();
    expect(body.available).toBe(true);
    const url = body.programs.termite.image.url;
    expect(url).toMatch(/^\/api\/public\/map-image\/v1\./);
    expect(signed.verifyMapImageToken(url.split('/').pop())).toMatchObject({ lat: '27.3600000', lng: '-82.3800000', zoom: 20 });
    expectNoKey(body);
  });

  test('cannot sign -> unavailable, no keyed fallback', async () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      const body = await invoke();
      expect(body).toEqual({ available: false, reason: 'provider_config_unavailable', programs: {} });
    } finally {
      process.env.JWT_SECRET = saved;
    }
  });
});

// ── static guard ────────────────────────────────────────────────────────────
const SERVER_ROOT = path.resolve(__dirname, '..');

function listServerSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listServerSources(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Modules allowed to reference the Google Static Maps endpoint. Anything else
// building a keyed Static Maps URL fails this test: customer-facing code must
// go through services/signed-map-image.js (or the token-scoped estimate proxy).
const STATIC_MAPS_ALLOWLIST = {
  'services/estimate-map-image.js': 'the keyless base URL + the ONLY place the key is appended, at fetch time inside the proxies; the key is never returned',
  'services/signed-map-image.js': 'builds KEYLESS urls for the signed proxy; imports the base from estimate-map-image',
  'routes/estimate-public.js': 'builds KEYLESS parcel-overlay URLs for the token-scoped proxy; payloads carry the proxy path only',
  'routes/property-lookup-v2.js': 'staff/tech-gated lookup + server-side vision fetches build keyed URLs; the public lookup route converts them to signed proxy URLs and scrubs the response',
  'services/satellite-analyzer.js': 'server-side satellite vision fetch; its keyed URLs are only returned to the staff-gated lookup path',
  'services/maps/providers/google-maps-provider.js': 'basemap provider returns a keyed imageUrl for STAFF dispatch only; customer surfaces sign center/zoom instead (satellite-treatment-map.js, routes/property.js)',
};

describe('static guard: keyed Static Maps URLs stay server-only / staff-only', () => {
  const files = listServerSources(SERVER_ROOT).map((f) => ({ rel: path.relative(SERVER_ROOT, f).split(path.sep).join('/'), src: fs.readFileSync(f, 'utf8') }));

  test('only allowlisted modules reference the Static Maps endpoint', () => {
    const referencing = files
      .filter(({ src }) => /maps\/api\/staticmap|GOOGLE_STATIC_MAP\b|STATIC_MAP_BASE/.test(src))
      .map(({ rel }) => rel)
      .sort();
    const unexpected = referencing.filter((rel) => !(rel in STATIC_MAPS_ALLOWLIST));
    expect(unexpected).toEqual([]);
  });

  test('every allowlist entry still exists and still references Static Maps (no stale entries)', () => {
    for (const rel of Object.keys(STATIC_MAPS_ALLOWLIST)) {
      const file = files.find((f) => f.rel === rel);
      expect(file).toBeDefined();
      expect(/maps\/api\/staticmap|GOOGLE_STATIC_MAP\b|STATIC_MAP_BASE/.test(file.src)).toBe(true);
    }
  });

  test('no server module hard-codes a Google API key', () => {
    const hits = files.filter(({ src }) => /key=AIza[0-9A-Za-z_-]{20,}/.test(src)).map(({ rel }) => rel);
    expect(hits).toEqual([]);
  });

  test('customer-facing map builders sign center/zoom instead of forwarding the provider imageUrl', () => {
    for (const rel of ['services/service-report/satellite-treatment-map.js', 'routes/property.js']) {
      const { src } = files.find((f) => f.rel === rel);
      expect(src).not.toMatch(/liveConfig\.imageUrl/);
      expect(src).toMatch(/signedMapImagePathFromLiveConfig/);
    }
  });

  test('the basemap live config is requested only by staff dispatch and the two signing builders', () => {
    const readers = files
      .filter(({ src }) => /\.getLiveMapConfig\(/.test(src))
      .map(({ rel }) => rel)
      .sort();
    expect(readers).toEqual([
      'routes/admin-dispatch.js',
      'routes/property.js',
      'services/service-report/satellite-treatment-map.js',
    ]);
  });

  test('the signed map proxy is mounted above the global cors(), limiter and body parsers', () => {
    const src = files.find((f) => f.rel === 'index.js').src;
    const mount = src.indexOf("app.use('/api/public/map-image'");
    expect(mount).toBeGreaterThan(-1);
    for (const later of ['app.use(cors(', "app.use('/api/', limiter)", 'app.use(express.json(']) {
      const at = src.indexOf(later);
      expect(at).toBeGreaterThan(-1);
      expect([later, mount < at]).toEqual([later, true]);
    }
  });
});
