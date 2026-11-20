// Staff roof read (GATE_ROOF_ENTRY_READ, owner 2026-11-19): the admin routes and the service behind them. Every HTTP
// fetch, the model call and the database are mocked: no network, no model and no database at any point.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const READ_A = '11111111-1111-4111-8111-111111111111';
const EST = '22222222-2222-4222-8222-222222222222';
const MISSING = '33333333-3333-4333-8333-333333333333';
const CUST = '44444444-4444-4444-8444-444444444444';
const EST2 = '55555555-5555-4555-8555-555555555555';

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const logger = require('../services/logger');

// In-memory roof_entry_reads (plus the estimates / customers the references are checked against): just the chains
// the service uses. Every statement is its own autocommit call and `mockEvents` records their order with the image fetch
// and the model call, so a test can prove nothing (no transaction, no lock) is held across the slow steps. The partial
// unique index (one pending row per crop) is emulated on insert; `mockOnConflict` runs when it fires.
let mockRows;
let mockRefs;
let mockDbCalls;
let mockEvents;
let mockOnConflict;
jest.mock('../models/db', () => {
  const table = (name) => {
    let where = {};
    let notWhere = {};
    let createdAfter = null;
    let claimedBefore = null;
    const source = () => (name === 'roof_entry_reads' ? mockRows : mockRefs[name] || []);
    const match = () => source()
      .filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))
      .filter((r) => Object.entries(notWhere).every(([k, v]) => r[k] !== v))
      .filter((r) => createdAfter == null || new Date(r.created_at).getTime() > createdAfter)
      .filter((r) => claimedBefore == null || new Date(r.claimed_at).getTime() < claimedBefore)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const settled = (fn) => {
      const run = async () => fn();
      return { returning: run, then: (ok, bad) => run().then(ok, bad), catch: (bad) => run().catch(bad) };
    };
    const b = {
      where(w) { where = { ...where, ...w }; return b; },
      whereNot(w) { notWhere = w; return b; },
      whereRaw(sql, [n]) {
        if (sql.includes('claimed_at')) claimedBefore = Date.now() - n * 60000;
        else createdAfter = Date.now() - n * 86400000;
        return b;
      },
      orderBy() { return b; },
      async first() { return match()[0]; },
      async select() { return match(); },
      insert(record) {
        const run = (ignoreConflict) => async () => {
          if (ignoreConflict && record.status === 'pending' && mockRows.some((r) => r.lookup_key === record.lookup_key && r.status === 'pending')) {
            if (mockOnConflict) mockOnConflict();
            return [];
          }
          mockEvents.push(record.status === 'pending' ? 'claim' : 'insert');
          const row = {
            id: `${String(mockRows.length + 1).padStart(8, '0')}-0000-4000-8000-000000000000`,
            tech_final_count: null,
            tech_final_flags: null,
            status: 'done',
            created_at: new Date().toISOString(),
            ...record,
            claimed_at: record.claimed_at === 'NOW' ? new Date().toISOString() : record.claimed_at,
          };
          mockRows.push(row);
          return [row];
        };
        return {
          returning: run(false),
          onConflict: () => ({ ignore: () => ({ returning: run(true) }) }),
        };
      },
      update(patch) {
        return settled(() => {
          mockEvents.push(`update:${patch.status || ''}`);
          const rows = match();
          rows.forEach((r) => Object.assign(r, patch));
          return rows;
        });
      },
      del() {
        return settled(() => {
          mockEvents.push('delete');
          const rows = match();
          mockRows = mockRows.filter((r) => !rows.includes(r));
          return rows.length;
        });
      },
    };
    return b;
  };
  const db = jest.fn((name) => { mockDbCalls.push(name); return table(name); });
  db.fn = { now: () => 'NOW' };
  db.transaction = jest.fn();
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

const mockAuth = jest.fn();
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => { mockAuth(); req.techRole = req.headers['x-test-role'] || 'technician'; next(); },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
}));

const express = require('express');
const router = require('../routes/admin-roof-entry-read');
const svc = require('../services/roof-entry-read');
const MODELS_PRIMARY_MODEL = require('../config/models').TEXT_POLICIES.estimateVision.primary.model;

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
  mockRefs = { estimates: [{ id: EST }, { id: EST2 }], customers: [{ id: CUST }] };
  mockDbCalls = [];
  mockEvents = [];
  mockOnConflict = null;
  mockAuth.mockClear();
  logger.info.mockClear();
  logger.warn.mockClear();
  mockDispatch.mockReset().mockImplementation(async () => {
    mockEvents.push('model');
    return { ok: true, provider: 'gemini', model: 'test-vision', json: goodWithPins(), usage: { input_tokens: 1500, output_tokens: 600 } };
  });
  mockLoadPrices.mockReset().mockImplementation(async () => { mockEvents.push('prices'); return { map: new Map() }; });
  mockCostUsd.mockReset().mockReturnValue(0.0123);
  fetchSpy = jest.fn().mockImplementation(async () => { mockEvents.push('image'); return jpeg(); });
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
const home = (over = {}) => ({ lat: 27.46, lng: -82.57, county: 'Manatee', ...over });

describe('gate and auth', () => {
  it('answers 404 {enabled:false} from the router with the gate off: no route-level database read, image fetch or model call (the portal\'s global middleware runs before it)', async () => {
    delete process.env.GATE_ROOF_ENTRY_READ;
    for (const res of [await post(home()), await call('PATCH', `/${READ_A}/tech-count`, { body: { count: 2 } })]) {
      expect(res.status).toBe(404);
      expect(res.json).toEqual({ enabled: false });
    }
    expect(mockDbCalls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('checks the gate before the staff login, so a dark gate never reaches the technicians lookup', async () => {
    delete process.env.GATE_ROOF_ENTRY_READ;
    // Even a technician token gets the plain 404, not a 403, and the login middleware never runs.
    expect((await post(home(), { role: 'technician' })).json).toEqual({ enabled: false });
    expect((await post(home(), { role: 'admin' })).json).toEqual({ enabled: false });
    expect(mockAuth).not.toHaveBeenCalled();
    process.env.GATE_ROOF_ENTRY_READ = 'true';
    await post(home({ county: 'nowhere' }));
    expect(mockAuth).toHaveBeenCalledTimes(1);
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

  it('reuses a stored read of the same crop within 90 days: no fetch, no model call', async () => {
    await post(home());
    // The key is the imagery source plus the centre rounded to 5 decimals (about 1 m).
    const again = await post(home({ lat: 27.460001, lng: -82.570002 }));
    expect(again.json.status).toBe('ok');
    expect(again.json.cached).toBe(true);
    expect(again.json.read.id).toBe(mockRows[0].id);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockRows).toHaveLength(1);
  });

  it('never hands one roof the pins of another: a different centre, or a different imagery source, is a new read', async () => {
    await post(home());
    const moved = await post(home({ lat: 27.4605 }));
    expect(moved.json.cached).toBe(false);
    // Same coordinates in another county's photo set is a different key.
    expect(svc.lookupKey({ source: 'manatee_2025_rgb', lat: 27.46, lng: -82.57 }))
      .not.toBe(svc.lookupKey({ source: 'sarasota_2025_3in', lat: 27.46, lng: -82.57 }));
    expect(mockDispatch).toHaveBeenCalledTimes(2);
    expect(mockRows).toHaveLength(2);
    expect(new Set(mockRows.map((r) => r.lookup_key)).size).toBe(2);
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

  it('dispatches the primary route only: the policy it passes has no fallback leg', async () => {
    await post(home());
    const policy = mockDispatch.mock.calls[0][0];
    expect(policy.primary).toEqual(expect.objectContaining({ provider: 'gemini' }));
    expect(policy.fallback).toBeNull();
    expect(mockDispatch.mock.calls[0][2]).toBeUndefined();
  });

  it('books a billed failed answer (unparseable JSON) as tier unknown with its cost, from that one call', async () => {
    mockDispatch.mockResolvedValue({
      ok: false,
      reason: 'all_providers_failed',
      failures: [{ provider: 'gemini', model: 'test-vision', reason: 'empty_json', usage: { input_tokens: 1200, output_tokens: 40 } }],
    });
    mockCostUsd.mockReturnValue(0.031);
    const res = await post(home());
    expect(res.json.status).toBe('ok');
    expect(res.json.read).toEqual(expect.objectContaining({ tier: 'unknown', flags: {}, model: 'test-vision' }));
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockCostUsd).toHaveBeenCalledWith('gemini', { input_tokens: 1200, output_tokens: 40 }, expect.anything());
    expect(mockRows[0].cost_estimate_cents).toBe(4);
    expect(mockRows[0].ai_tier).toBe('unknown');
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
    for (const body of [{}, home({ lat: 'x' }), home({ lat: 95 }), home({ county: '' }), home({ estimate_id: 'nope' }), home({ county: 'x'.repeat(41) })]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('unreadable roof', () => {
  it('stores the model\'s own tier unknown with no flags and never reuses it', async () => {
    mockDispatch.mockResolvedValue({ ok: true, provider: 'gemini', model: 'test-vision', json: goodJson({ tier: 'unknown' }), usage: {} });
    const first = await post(home());
    expect(first.json.read).toEqual(expect.objectContaining({ tier: 'unknown', flags: {} }));
    mockDispatch.mockResolvedValue({ ok: true, provider: 'gemini', model: 'test-vision', json: goodJson({ tier: 'low' }), usage: {} });
    const second = await post(home());
    expect(second.json.cached).toBe(false);
    expect(second.json.read.tier).toBe('low');
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });

  it('tells the model to answer tier unknown, not low, when the roof cannot be read', async () => {
    await post(home());
    const { text } = mockDispatch.mock.calls[0][1];
    expect(text).toMatch(/tier "unknown"/);
    expect(text).not.toMatch(/tier "low"\./);
  });
});

describe('references and county text', () => {
  it('refuses a missing estimate or customer with 400 before any image fetch or model call', async () => {
    for (const body of [home({ estimate_id: MISSING }), home({ customer_id: MISSING })]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockEvents).not.toContain('claim');
  });

  it('accepts existing references and stores them', async () => {
    const res = await post(home({ estimate_id: EST, customer_id: CUST }));
    expect(res.json.read).toEqual(expect.objectContaining({ estimate_id: EST, customer_id: CUST }));
  });

  it('logs only the allowlisted county key, or the word unsupported, never the typed text', async () => {
    await post(home({ county: '555 Example Rd Unit 4' }));
    await post(home({ county: 'Sarasota County' }));
    const lines = logger.info.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('county=unsupported'))).toBe(true);
    expect(lines.some((l) => l.includes('county=sarasota'))).toBe(true);
    expect([...logger.info.mock.calls, ...logger.warn.mock.calls].map((c) => String(c[0])).join('\n')).not.toMatch(/555|Example/);
  });
});

const CROP_KEY = () => svc.lookupKey({ source: 'manatee_2025_rgb', lat: 27.46, lng: -82.57 });
const crop = (over = {}) => ({
  id: 'row-x', lookup_key: CROP_KEY(), county: 'manatee', image_source: 'manatee_2025_rgb', image_year: 2025, model: 'm',
  ai_flags: '{}', ai_tier: 'pending', status: 'pending', cost_estimate_cents: 0, estimate_id: null, customer_id: null,
  tech_final_count: null, tech_final_flags: null, created_at: new Date().toISOString(), claimed_at: new Date().toISOString(), ...over,
});
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

describe('claim row', () => {
  it('commits the claim before the image fetch and writes the result after the model call, holding no transaction in between', async () => {
    await post(home());
    // Prices are read before the claim; the claim, the fetch, the model call and the write happen in this order, each
    // database step its own statement, so no connection is held across the slow, paid steps.
    expect(mockEvents).toEqual(['prices', 'claim', 'image', 'model', 'update:done']);
    expect(require('../models/db').transaction).not.toHaveBeenCalled();
    expect(mockRows).toHaveLength(1);
    expect(mockRows[0]).toEqual(expect.objectContaining({ status: 'done', ai_tier: 'med', model: 'test-vision' }));
    expect(mockRows[0].cost_estimate_cents).toBe(2);
  });

  it('claims with this request\'s context and the policy model before the call', async () => {
    let atCall;
    mockDispatch.mockImplementation(async () => {
      atCall = { ...mockRows[0] };
      return { ok: true, provider: 'gemini', model: 'test-vision', json: goodJson(), usage: {} };
    });
    await post(home({ estimate_id: EST, customer_id: CUST }));
    expect(atCall).toEqual(expect.objectContaining({ status: 'pending', ai_tier: 'pending', estimate_id: EST, customer_id: CUST, county: 'manatee', image_source: 'manatee_2025_rgb', image_year: 2025, cost_estimate_cents: 0 }));
    expect(atCall.model).toBe(MODELS_PRIMARY_MODEL);
    expect(atCall.claimed_at).toEqual(expect.any(String));
  });

  it('answers 202 in_progress with no image fetch and no model call while another request holds the crop', async () => {
    mockRows.push(crop({ claimed_at: minutesAgo(1) }));
    const res = await post(home());
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ status: 'in_progress', cached: false, read: null });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockRows).toHaveLength(1);
  });

  it('looks once more after a conflict: a read the holder just finished is the answer', async () => {
    mockRows.push(crop({ claimed_at: minutesAgo(1) }));
    mockOnConflict = () => {
      mockRows.length = 0;
      mockRows.push(crop({ id: 'done-row', status: 'done', ai_tier: 'high', ai_flags: JSON.stringify(goodJson().flags), cost_estimate_cents: 3, claimed_at: null }));
    };
    const res = await post(home());
    expect(res.status).toBe(200);
    expect(res.json).toEqual(expect.objectContaining({ status: 'ok', cached: true }));
    expect(res.json.read.id).toBe('done-row');
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('takes over a claim older than 5 minutes: marks it failed and pays once', async () => {
    mockRows.push(crop({ id: 'stale', claimed_at: minutesAgo(6) }));
    const res = await post(home());
    expect(res.json).toEqual(expect.objectContaining({ status: 'ok', cached: false }));
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockRows.find((r) => r.id === 'stale')).toEqual(expect.objectContaining({ status: 'failed', ai_tier: 'unknown' }));
    expect(mockRows.filter((r) => r.status === 'done')).toHaveLength(1);
    expect(mockRows.filter((r) => r.status === 'pending')).toHaveLength(0);
  });

  it('does not take over a claim that is under 5 minutes old', async () => {
    mockRows.push(crop({ claimed_at: minutesAgo(4) }));
    expect((await post(home())).status).toBe(202);
    expect(mockRows[0].status).toBe('pending');
  });

  it('keeps the paid row when the estimate is deleted while the call runs (the reference is set to null)', async () => {
    mockDispatch.mockImplementation(async () => {
      // ON DELETE SET NULL, as the database does it.
      mockRows.forEach((r) => { if (r.estimate_id === EST) r.estimate_id = null; });
      mockRefs.estimates = [];
      return { ok: true, provider: 'gemini', model: 'test-vision', json: goodWithPins(), usage: { input_tokens: 10, output_tokens: 10 } };
    });
    const res = await post(home({ estimate_id: EST }));
    expect(res.json.status).toBe('ok');
    expect(mockRows).toHaveLength(1);
    expect(mockRows[0]).toEqual(expect.objectContaining({ status: 'done', estimate_id: null, ai_tier: 'med' }));
    expect(mockRows[0].cost_estimate_cents).toBeGreaterThan(0);
    expect(res.json.read.flags.plumbing_vent_stacks.likely).toBe('yes');
  });

  it('releases the claim when there is no image or the call fails before billing, so the crop can be claimed again', async () => {
    fetchSpy.mockRejectedValue(new Error('down'));
    expect((await post(home())).json.status).toBe('no_image');
    expect(mockRows).toHaveLength(0);
    fetchSpy.mockImplementation(async () => jpeg());
    mockDispatch.mockResolvedValue({ ok: false, reason: 'all_providers_failed', failures: [] });
    expect((await post(home())).json.status).toBe('model_failed');
    expect(mockRows).toHaveLength(0);
  });

  it('marks the claim failed on an unexpected error, never leaving the crop pending', async () => {
    mockDispatch.mockRejectedValue(new Error('boom'));
    expect((await post(home())).status).toBe(500);
    expect(mockRows).toHaveLength(1);
    expect(mockRows[0]).toEqual(expect.objectContaining({ status: 'failed', ai_tier: 'unknown' }));
    mockDispatch.mockResolvedValue({ ok: true, provider: 'gemini', model: 'test-vision', json: goodJson(), usage: {} });
    expect((await post(home())).json.read.tier).toBe('med');
  });

  it('shares one paid call between two different contexts asked together: the other gets in_progress or a copy', async () => {
    const [a, b] = await Promise.all([post(home({ estimate_id: EST })), post(home({ estimate_id: EST2 }))]);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const paid = [a, b].filter((r) => r.json.status === 'ok' && r.json.cached === false);
    expect(paid).toHaveLength(1);
    expect(mockRows.filter((r) => r.status === 'pending')).toHaveLength(0);
  });

  it('treats an upper-case UUID as the same context as its lower-case spelling', async () => {
    const first = await post(home({ estimate_id: EST.toUpperCase() }));
    expect(first.json.read.estimate_id).toBe(EST);
    expect(mockRows[0].estimate_id).toBe(EST);
    const again = await post(home({ estimate_id: EST }));
    const upper = await post(home({ estimate_id: EST.toUpperCase() }));
    expect(again.json.read.id).toBe(first.json.read.id);
    expect(upper.json.read.id).toBe(first.json.read.id);
    expect(mockRows).toHaveLength(1);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    // The service is called directly the same way.
    const direct = await svc.runRoofEntryRead({ lat: 27.46, lng: -82.57, county: 'Manatee', estimateId: EST.toUpperCase() });
    expect(direct.read.id).toBe(first.json.read.id);
  });
});

describe('a billed unusable answer', () => {
  it('books it as a failed row with its cost, which a LATER request does not reuse and may retry', async () => {
    mockDispatch.mockResolvedValue({
      ok: false,
      reason: 'all_providers_failed',
      failures: [{ provider: 'gemini', model: 'test-vision', reason: 'empty_json', usage: { input_tokens: 100, output_tokens: 5 } }],
    });
    const first = await post(home());
    expect(first.json.read.tier).toBe('unknown');
    expect(mockRows[0]).toEqual(expect.objectContaining({ status: 'failed', ai_tier: 'unknown' }));
    expect(mockRows[0].cost_estimate_cents).toBeGreaterThan(0);
    mockDispatch.mockResolvedValue({ ok: true, provider: 'gemini', model: 'test-vision', json: goodJson(), usage: {} });
    const second = await post(home());
    expect(second.json.cached).toBe(false);
    expect(second.json.read.tier).toBe('med');
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });
});

describe('one row per estimate or customer context', () => {
  it('gives a second estimate on the same crop its own row, one paid call, and keeps technician feedback apart', async () => {
    const a = await post(home({ estimate_id: EST }));
    const b = await post(home({ estimate_id: EST2 }));
    expect(b.json.cached).toBe(true);
    expect(b.json.read.id).not.toBe(a.json.read.id);
    expect(b.json.read).toEqual(expect.objectContaining({ estimate_id: EST2, tier: a.json.read.tier, flags: a.json.read.flags, model: a.json.read.model, tech_final_count: null }));
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockRows).toHaveLength(2);
    expect(mockRows.map((r) => r.cost_estimate_cents)).toEqual([2, 0]);
    expect(mockRows[0].lookup_key).toBe(mockRows[1].lookup_key);

    // The same context asked again gets its own existing row, not a third one.
    expect((await post(home({ estimate_id: EST2 }))).json.read.id).toBe(b.json.read.id);
    expect((await post(home({ estimate_id: EST }))).json.read.id).toBe(a.json.read.id);
    expect(mockRows).toHaveLength(2);

    const patched = await call('PATCH', `/${a.json.read.id}/tech-count`, { body: { count: 5, flags: { gable_vents: 'yes' } } });
    expect(patched.status).toBe(200);
    expect(mockRows.find((r) => r.id === a.json.read.id).tech_final_count).toBe(5);
    expect(mockRows.find((r) => r.id === b.json.read.id).tech_final_count).toBeNull();
    expect(mockRows.find((r) => r.id === b.json.read.id).tech_final_flags).toBeNull();
  });

  it('answers a context-free ask with the original row and a customer context with a copy', async () => {
    const first = await post(home());
    const withCustomer = await post(home({ customer_id: CUST }));
    expect(withCustomer.json.read.id).not.toBe(first.json.read.id);
    expect(withCustomer.json.read.customer_id).toBe(CUST);
    expect((await post(home())).json.read.id).toBe(first.json.read.id);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockLoadPrices).toHaveBeenCalledTimes(1);
  });

  it('counts the reuse window from the paid read: a copy never extends it', async () => {
    const key = svc.lookupKey({ source: 'manatee_2025_rgb', lat: 27.46, lng: -82.57 });
    const day = 86400000;
    const base = { lookup_key: key, county: 'manatee', image_source: 'manatee_2025_rgb', image_year: 2025, model: 'm', ai_flags: JSON.stringify(goodJson().flags), ai_tier: 'med', status: 'done', tech_final_count: null, tech_final_flags: null };
    // Paid 91 days ago; a copy for estimate 2 was made at day 86 (5 days ago).
    mockRows.push({ ...base, id: 'paid', cost_estimate_cents: 2, estimate_id: null, customer_id: null, created_at: new Date(Date.now() - 91 * day).toISOString() });
    mockRows.push({ ...base, id: 'copy', cost_estimate_cents: 0, estimate_id: EST2, customer_id: null, created_at: new Date(Date.now() - 5 * day).toISOString() });
    const res = await post(home({ estimate_id: EST2 }));
    expect(res.json.cached).toBe(false);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    // The new paid read starts a new window; a copy made now is reused from it.
    const other = await post(home({ estimate_id: EST }));
    expect(other.json.cached).toBe(true);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
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
    ['pins on an "unsure"', withEntry('chimney_or_flue', entry('unsure', [{ x: 0.2, y: 0.5 }]))],
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
