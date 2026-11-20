// Staff roof read (GATE_ROOF_ENTRY_READ, owner 2026-11-19): the admin routes and the service behind them. Every HTTP
// fetch, the model call and the database are mocked: no network, no model and no database at any point.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const READ_A = '11111111-1111-4111-8111-111111111111';
const EST = '22222222-2222-4222-8222-222222222222';
const MISSING = '33333333-3333-4333-8333-333333333333';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

// In-memory roof_entry_reads: just the chains the service uses.
let mockRows;
let mockDbCalls;
jest.mock('../models/db', () => {
  const table = () => {
    let where = {};
    let notWhere = {};
    let cutoff = null;
    const match = () => mockRows
      .filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))
      .filter((r) => Object.entries(notWhere).every(([k, v]) => r[k] !== v))
      .filter((r) => cutoff == null || new Date(r.created_at).getTime() > cutoff)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const b = {
      where(w) { where = { ...where, ...w }; return b; },
      whereNot(w) { notWhere = w; return b; },
      whereRaw(_sql, [days]) { cutoff = Date.now() - days * 86400000; return b; },
      orderBy() { return b; },
      async first() { return match()[0]; },
      insert(record) {
        return {
          async returning() {
            const row = { id: `read-${mockRows.length + 1}`, tech_final_count: null, tech_final_flags: null, created_at: new Date().toISOString(), ...record };
            mockRows.push(row);
            return [row];
          },
        };
      },
      update(patch) {
        return {
          async returning() {
            const rows = match();
            rows.forEach((r) => Object.assign(r, patch));
            return rows;
          },
        };
      },
    };
    return b;
  };
  const db = jest.fn((name) => { mockDbCalls.push(name); return table(); });
  return db;
});

const mockDispatch = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: (...a) => mockDispatch(...a) }));

const mockLoadPrices = jest.fn();
const mockCostUsd = jest.fn();
jest.mock('../services/llm-cost', () => ({
  loadPrices: (...a) => mockLoadPrices(...a),
  priceFor: jest.fn(() => ({ input: 1, output: 1 })),
  costUsd: (...a) => mockCostUsd(...a),
}));

jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.techRole = req.headers['x-test-role'] || 'technician'; next(); },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
}));

const express = require('express');
const router = require('../routes/admin-roof-entry-read');
const svc = require('../services/roof-entry-read');

const entry = (likely = 'unsure', pins = []) => ({ likely, pins });
const goodJson = (over = {}) => ({
  flags: Object.fromEntries(svc.ENTRY_TYPES.map((t) => [t, entry()])),
  tier: 'med',
  ...over,
});
const goodWithPins = () => {
  const j = goodJson();
  j.flags.plumbing_vent_stacks = entry('yes', [{ x: 0.4, y: 0.5 }, { x: 0.45, y: 0.52 }]);
  j.flags.chimney_or_flue = entry('no');
  return j;
};
const jpeg = (type = 'image/jpeg', ok = true) => ({
  ok,
  headers: { get: () => type },
  arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).buffer,
});

let server;
let baseUrl;
let fetchSpy;
beforeAll(() => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/roof-entry-read', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const realFetch = global.fetch;
const savedGate = process.env.GATE_ROOF_ENTRY_READ;
beforeEach(() => {
  process.env.GATE_ROOF_ENTRY_READ = 'true';
  mockRows = [];
  mockDbCalls = [];
  mockDispatch.mockReset().mockResolvedValue({ ok: true, provider: 'gemini', model: 'test-vision', json: goodWithPins(), usage: { input_tokens: 1500, output_tokens: 600 } });
  mockLoadPrices.mockReset().mockResolvedValue({ map: new Map() });
  mockCostUsd.mockReset().mockReturnValue(0.0123);
  fetchSpy = jest.fn().mockResolvedValue(jpeg());
  // The app under test is reached with the real fetch; only the county image calls are faked.
  global.fetch = (url, opts) => (String(url).startsWith(baseUrl) ? realFetch(url, opts) : fetchSpy(url, opts));
});
afterEach(() => {
  global.fetch = realFetch;
  if (savedGate === undefined) delete process.env.GATE_ROOF_ENTRY_READ; else process.env.GATE_ROOF_ENTRY_READ = savedGate;
});

async function call(method, path, { role = 'admin', body } = {}) {
  const res = await realFetch(`${baseUrl}/api/admin/roof-entry-read${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-role': role },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const post = (body, opts) => call('POST', '', { body, ...opts });
const home = (over = {}) => ({ lat: 27.46, lng: -82.57, county: 'Manatee', address: '100 Example St, Bradenton FL', ...over });

describe('gate and auth', () => {
  it('answers 404 {enabled:false} with the gate off, before any database read, image fetch or model call', async () => {
    delete process.env.GATE_ROOF_ENTRY_READ;
    for (const res of [await post(home()), await call('PATCH', `/${READ_A}/tech-count`, { body: { count: 2 } })]) {
      expect(res.status).toBe(404);
      expect(res.json).toEqual({ enabled: false });
    }
    expect(mockDbCalls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('keeps a technician out even with the gate on', async () => {
    const res = await post(home(), { role: 'technician' });
    expect(res.status).toBe(403);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('POST /', () => {
  it('fetches the county crop, makes one vision call and returns the stable shape', async () => {
    const res = await post(home({ estimate_id: EST }));
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('ok');
    expect(res.json.cached).toBe(false);
    expect(res.json.read).toEqual(expect.objectContaining({
      id: expect.any(String),
      estimate_id: EST,
      customer_id: null,
      county: 'manatee',
      image_source: 'manatee_2025_rgb',
      image_year: 2025,
      model: 'test-vision',
      tier: 'med',
      tech_final_count: null,
      tech_final_flags: null,
    }));
    expect(Object.keys(res.json.read.flags).sort()).toEqual([...svc.ENTRY_TYPES].sort());
    expect(res.json.read.flags.plumbing_vent_stacks).toEqual({ likely: 'yes', pins: [{ x: 0.4, y: 0.5 }, { x: 0.45, y: 0.52 }] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const payload = mockDispatch.mock.calls[0][1];
    expect(payload.images).toEqual([{ data: expect.any(String), mimeType: 'image/jpeg' }]);
    expect(payload.jsonMode).toBe(true);
    expect(payload.laneId).toBe('satellite');
    expect(mockRows).toHaveLength(1);
    expect(mockRows[0].cost_estimate_cents).toBe(2);
  });

  it('books the ceiling estimate when the model price is unknown', async () => {
    mockCostUsd.mockReturnValue(null);
    await post(home());
    expect(mockRows[0].cost_estimate_cents).toBe(svc.FALLBACK_COST_CENTS);
  });

  it('reuses a stored read of the same property within 90 days: no fetch, no model call', async () => {
    await post(home());
    // Same address typed differently: the key is the normalized address.
    const again = await post(home({ address: '100  EXAMPLE st bradenton, fl.' }));
    expect(again.json.status).toBe('ok');
    expect(again.json.cached).toBe(true);
    expect(again.json.read.id).toBe(mockRows[0].id);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockRows).toHaveLength(1);
  });

  it('runs a new read once a stored one is older than 90 days', async () => {
    await post(home());
    mockRows[0].created_at = new Date(Date.now() - 91 * 86400000).toISOString();
    const again = await post(home());
    expect(again.json.cached).toBe(false);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });

  it('makes one model call for two reads of the same property started together', async () => {
    const [a, b] = await Promise.all([post(home()), post(home())]);
    expect(a.json.status).toBe('ok');
    expect(b.json.status).toBe('ok');
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('answers no_image and makes no model call for a county without a service', async () => {
    const res = await post(home({ county: 'Hillsborough' }));
    expect(res.json).toEqual({ status: 'no_image', cached: false, read: null });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockRows).toHaveLength(0);
  });

  it.each([
    ['a JSON error body on a 200', () => jpeg('application/json')],
    ['an HTTP error', () => jpeg('image/jpeg', false)],
  ])('answers no_image and makes no model call on %s', async (_name, make) => {
    fetchSpy.mockResolvedValue(make());
    const res = await post(home());
    expect(res.json.status).toBe('no_image');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('answers no_image when the image fetch throws', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    const res = await post(home());
    expect(res.json.status).toBe('no_image');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('answers model_failed and stores nothing when the model call fails', async () => {
    mockDispatch.mockResolvedValue({ ok: false, reason: 'all_providers_failed', failures: [] });
    const res = await post(home());
    expect(res.json).toEqual({ status: 'model_failed', cached: false, read: null });
    expect(mockRows).toHaveLength(0);
  });

  it('stores tier unknown with no pins for an answer that breaks the schema, and does not reuse it', async () => {
    const bad = goodWithPins();
    delete bad.flags.gable_vents;
    mockDispatch.mockResolvedValue({ ok: true, provider: 'gemini', model: 'test-vision', json: bad, usage: {} });
    const res = await post(home());
    expect(res.json.status).toBe('ok');
    expect(res.json.read.tier).toBe('unknown');
    expect(res.json.read.flags).toEqual({});
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    // The call was paid for and is on the books, but the next ask gets a fresh read.
    expect(mockRows).toHaveLength(1);
    mockDispatch.mockResolvedValue({ ok: true, provider: 'gemini', model: 'test-vision', json: goodJson(), usage: {} });
    const again = await post(home());
    expect(again.json.cached).toBe(false);
    expect(again.json.read.tier).toBe('med');
  });

  it('rejects a bad body with 400 before any fetch or call', async () => {
    for (const body of [{}, home({ lat: 'x' }), home({ lat: 95 }), home({ county: '' }), home({ estimate_id: 'nope' }), home({ address: 7 })]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('county imagery requests', () => {
  it.each([
    ['Manatee', 'www.mymanatee.org', '/gisimg/rest/services/2025/AERIAL_2025_RGB/ImageServer/exportImage'],
    ['Sarasota County', 'srqgis.sarasotafl.gov', '/server/rest/services/Aerials_COS_2025/ImageServer/exportImage'],
    ['charlotte', 'agis.charlottecountyfl.gov', '/arcgis/rest/services/Aerials/Aerials2026/MapServer/export'],
  ])('%s asks the free public service for a ~60 m square crop', async (county, host, pathName) => {
    await svc.fetchAerial(27.3, -82.5, county);
    const url = new URL(fetchSpy.mock.calls[0][0]);
    expect(url.host).toBe(host);
    expect(url.pathname).toBe(pathName);
    expect(url.searchParams.get('f')).toBe('image');
    expect(url.searchParams.get('format')).toBe('jpg');
    const [x1, y1, x2, y2] = url.searchParams.get('bbox').split(',').map(Number);
    expect(x2 - x1).toBeCloseTo(y2 - y1, 0);
    // 60 m on the ground, stretched by 1/cos(lat) in Web Mercator.
    expect((x2 - x1) * Math.cos((27.3 * Math.PI) / 180)).toBeCloseTo(60, 0);
    expect(url.searchParams.get('key')).toBeNull();
  });
});

describe('validateRead', () => {
  const withEntry = (type, value) => { const j = goodJson(); j.flags[type] = value; return j; };
  it('accepts a full, well-formed read and drops extra keys', () => {
    const j = goodWithPins();
    j.extra = 1;
    j.flags.gable_vents.count = 4;
    const out = svc.validateRead(j);
    expect(out.tier).toBe('med');
    expect(out.flags.gable_vents).toEqual({ likely: 'unsure', pins: [] });
    expect(out).not.toHaveProperty('extra');
  });

  it.each([
    ['null', null],
    ['an unknown tier', goodJson({ tier: 'extreme' })],
    ['no tier', goodJson({ tier: undefined })],
    ['flags as an array', goodJson({ flags: [] })],
    ['a bad likely value', withEntry('chimney_or_flue', entry('maybe'))],
    ['a missing type', (() => { const j = goodJson(); delete j.flags.gable_vents; return j; })()],
    ['seven pins', withEntry('chimney_or_flue', entry('yes', Array.from({ length: 7 }, () => ({ x: 0.1, y: 0.1 }))))],
    ['a pin past 1', withEntry('chimney_or_flue', entry('yes', [{ x: 1.2, y: 0.5 }]))],
    ['a string pin', withEntry('chimney_or_flue', entry('yes', [{ x: '0.2', y: 0.5 }]))],
    ['pins on a "no"', withEntry('chimney_or_flue', entry('no', [{ x: 0.2, y: 0.5 }]))],
    ['pins that are not a list', withEntry('chimney_or_flue', { likely: 'yes', pins: 'here' })],
  ])('rejects %s', (_name, json) => {
    expect(svc.validateRead(json)).toBeNull();
  });
});

describe('PATCH /:id/tech-count', () => {
  beforeEach(() => { mockRows.push({ id: READ_A, lookup_key: 'k', county: 'manatee', image_source: 's', image_year: 2025, model: 'm', ai_flags: {}, ai_tier: 'med', tech_final_count: null, tech_final_flags: null, created_at: new Date().toISOString() }); });

  it('stores the count and flags beside the AI read', async () => {
    const res = await call('PATCH', `/${READ_A}/tech-count`, { body: { count: 4, flags: { plumbing_vent_stacks: 'yes', gable_vents: 'no' } } });
    expect(res.status).toBe(200);
    expect(res.json.read).toEqual(expect.objectContaining({ id: READ_A, tech_final_count: 4, tech_final_flags: { plumbing_vent_stacks: 'yes', gable_vents: 'no' }, tier: 'med' }));
    expect(mockRows[0].tech_final_count).toBe(4);
    expect(JSON.parse(mockRows[0].tech_final_flags)).toEqual({ plumbing_vent_stacks: 'yes', gable_vents: 'no' });
  });

  it('accepts a count of 0 and leaves flags alone when only the count is sent', async () => {
    const res = await call('PATCH', `/${READ_A}/tech-count`, { body: { count: 0 } });
    expect(res.status).toBe(200);
    expect(res.json.read.tech_final_count).toBe(0);
    expect(mockRows[0].tech_final_flags).toBeNull();
  });

  it.each([
    ['nothing', {}],
    ['a negative count', { count: -1 }],
    ['a fractional count', { count: 2.5 }],
    ['a huge count', { count: 501 }],
    ['a string count', { count: '3' }],
    ['an unknown type', { flags: { attic_door: 'yes' } }],
    ['a bad value', { flags: { gable_vents: 'maybe' } }],
    ['flags as a list', { flags: ['gable_vents'] }],
  ])('rejects %s with 400 and writes nothing', async (_name, body) => {
    const res = await call('PATCH', `/${READ_A}/tech-count`, { body });
    expect(res.status).toBe(400);
    expect(mockRows[0].tech_final_count).toBeNull();
  });

  it('answers 404 for an unknown or malformed id', async () => {
    expect((await call('PATCH', `/${MISSING}/tech-count`, { body: { count: 1 } })).status).toBe(404);
    expect((await call('PATCH', '/not-a-uuid/tech-count', { body: { count: 1 } })).status).toBe(404);
  });

  it('keeps a technician out', async () => {
    expect((await call('PATCH', `/${READ_A}/tech-count`, { role: 'technician', body: { count: 1 } })).status).toBe(403);
    expect(mockRows[0].tech_final_count).toBeNull();
  });
});
